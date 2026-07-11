#!/usr/bin/env node
/**
 * Blocking helper: play a sound, THEN speak — never concurrently.
 *
 * Spawned detached by src/platform/sequencer.ts (so the calling hook never
 * blocks); this process itself blocks on the sound in sequence, guaranteeing
 * the sound finishes before the voice starts. It also tracks the voice PID in a
 * pidfile so src/core/control.ts can pause/resume/stop the reading in progress.
 *
 * Plain ESM with ZERO imports from src — it ships in the npm package and runs
 * standalone under `node`. The payload (both argv arrays and the pidfile path)
 * is passed as a single JSON argument, since this file cannot re-derive
 * HOLLR_HOME from the source tree.
 *
 * Every path is defensive: any failure must exit 0, never throw, because this
 * runs unattended behind a Claude Code hook.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PID_ENCODING = "utf8";

/** Record the voice PID so control.ts can find it. Best-effort. */
function writePid(pidPath, pid) {
  try {
    writeFileSync(pidPath, String(pid), PID_ENCODING);
  } catch {
    // PID tracking is best-effort; a write failure just disables control.
  }
}

/**
 * Remove the pidfile only if it still names `pid` — guards against clobbering
 * the tracking of a newer reading that took over while this one was ending.
 */
function clearPidIfOwned(pidPath, pid) {
  try {
    const raw = readFileSync(pidPath, PID_ENCODING).trim();
    if (raw === String(pid)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Nothing to clear.
  }
}

/**
 * @param {{ soundArgv: string[] | null, voiceArgv: string[] | null, pidPath: string }} payload
 */
export function run(payload) {
  try {
    if (Array.isArray(payload.soundArgv)) {
      const [command, ...args] = payload.soundArgv;
      spawnSync(command, args);
    }
    if (Array.isArray(payload.voiceArgv)) {
      const [command, ...args] = payload.voiceArgv;
      const child = spawn(command, args);
      child.on("error", () => {});
      if (typeof child.pid === "number") {
        writePid(payload.pidPath, child.pid);
        child.on("close", () => clearPidIfOwned(payload.pidPath, child.pid));
      }
    }
  } catch {
    // Never propagate — a missing binary or bad payload must not crash the hook.
  }
}

function isEntry() {
  const entry = process.argv[1];
  return entry !== undefined && entry === fileURLToPath(import.meta.url);
}

if (isEntry()) {
  try {
    run(JSON.parse(process.argv[2]));
  } catch {
    process.exit(0);
  }
}
