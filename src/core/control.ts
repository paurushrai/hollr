/**
 * Read-aloud control: pause / resume / stop the running voice process by PID.
 *
 * No daemon and no extra permissions — just a pidfile the helper writes plus
 * POSIX signals. A user binds a global hotkey to `hollr pause|resume|stop`,
 * which reaches into the detached voice process started by the sequencer.
 * Every operation is defensive: a missing, stale, or garbage pidfile must never
 * throw, because this can run unattended from a hotkey. Ported from v1
 * `lib/control.py`.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { hollrHome } from "./config.ts";
import type { Platform } from "../platform/index.ts";
import { selectPlatform } from "../platform/index.ts";

const READING_PIDFILE_NAME = "reading.pid";
const SIGNAL_STOP: NodeJS.Signals = "SIGSTOP";
const SIGNAL_CONT: NodeJS.Signals = "SIGCONT";
const SIGNAL_TERM: NodeJS.Signals = "SIGTERM";

const MSG_PAUSED = "hollr: reading paused";
const MSG_RESUMED = "hollr: reading resumed";
const MSG_STOPPED = "hollr: reading stopped";
const MSG_NOTHING = "hollr: nothing is being read";
const MSG_PAUSE_UNSUPPORTED = "hollr: pause is not supported on Windows — use hollr stop";

/** Matches a plain integer (optionally signed) — anything else is not a PID. */
const INTEGER_RE = /^-?\d+$/;

/** Send a signal to a PID; a real `process.kill` or a test double. */
export type KillFn = (pid: number, signal?: NodeJS.Signals | number) => void;

export interface ControlDeps {
  platform: Platform;
  kill: KillFn;
  pidPath: string;
}

/** Production defaults, resolved lazily so tests can inject their own. */
function defaultDeps(): ControlDeps {
  return {
    platform: selectPlatform(),
    kill: process.kill.bind(process),
    pidPath: join(hollrHome(), READING_PIDFILE_NAME),
  };
}

/** Return the tracked PID, or `null` if the pidfile is missing/empty/non-integer. */
function readPid(pidPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!INTEGER_RE.test(raw)) {
    return null;
  }
  return Number.parseInt(raw, 10);
}

/** Remove the pidfile if present. Never raises. */
function clearPid(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // Missing/locked pidfile — nothing to clear.
  }
}

/**
 * Send `signal` (or the platform default when `undefined`) to the tracked PID.
 * A dead/unsignalable PID means the pidfile is stale from a reading that already
 * ended — clear it and report that nothing is being read, rather than raising.
 */
function signalReader(
  deps: ControlDeps,
  signal: NodeJS.Signals | undefined,
  successMessage: string,
): string {
  const pid = readPid(deps.pidPath);
  if (pid === null) {
    return MSG_NOTHING;
  }
  try {
    if (signal === undefined) {
      deps.kill(pid);
    } else {
      deps.kill(pid, signal);
    }
  } catch {
    clearPid(deps.pidPath);
    return MSG_NOTHING;
  }
  return successMessage;
}

/** Suspend the in-progress reading (SIGSTOP). Unsupported on Windows. */
export function pauseReading(deps: ControlDeps = defaultDeps()): string {
  if (!deps.platform.canPauseResume) {
    return MSG_PAUSE_UNSUPPORTED;
  }
  return signalReader(deps, SIGNAL_STOP, MSG_PAUSED);
}

/** Resume a paused reading (SIGCONT). Unsupported on Windows. */
export function resumeReading(deps: ControlDeps = defaultDeps()): string {
  if (!deps.platform.canPauseResume) {
    return MSG_PAUSE_UNSUPPORTED;
  }
  return signalReader(deps, SIGNAL_CONT, MSG_RESUMED);
}

/**
 * Terminate the in-progress reading and clear the pidfile. POSIX uses SIGTERM;
 * Windows cannot signal, so it uses the default `process.kill` termination.
 */
export function stopReading(deps: ControlDeps = defaultDeps()): string {
  const signal = deps.platform.canPauseResume ? SIGNAL_TERM : undefined;
  const message = signalReader(deps, signal, MSG_STOPPED);
  if (message === MSG_STOPPED) {
    clearPid(deps.pidPath);
  }
  return message;
}
