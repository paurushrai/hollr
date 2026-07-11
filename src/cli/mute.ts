/**
 * `hollr mute [on|off]`: toggle a per-project mute flag file that the router
 * checks (`isMuted`) to stay fully silent for a project. `on` mutes, `off`
 * unmutes, and a bare `mute` toggles. Unmuting is best-effort (an already-absent
 * flag is success). Muting, however, must NOT report success if the flag was
 * never written: a write failure surfaces so the caller does not believe a
 * project is muted when it is not.
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { encodeCwd, hollrHome, isMuted } from "../core/config.ts";
import { projectLabel } from "../core/events.ts";

const PROJECTS_DIR = "projects";
const MUTED_SUFFIX = ".muted";
const EXIT_OK = 0;

function muteFlagPath(cwd: string): string {
  return join(hollrHome(), PROJECTS_DIR, `${encodeCwd(cwd)}${MUTED_SUFFIX}`);
}

/** Desired mute state: `on` → true, `off` → false, anything else → toggle. */
function desiredState(sub: string | undefined, cwd: string): boolean {
  if (sub === "on") {
    return true;
  }
  if (sub === "off") {
    return false;
  }
  return !isMuted(cwd);
}

function createFlag(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch (cause) {
    // Unlike removeFlag, a failed create must NOT look like success: re-throw
    // with an actionable message so the dispatch surfaces it (non-zero exit).
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not write mute flag at ${path}: ${reason}`);
  }
}

function removeFlag(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already absent — nothing to unmute.
  }
}

/** Apply the requested mute state and print the resulting state. */
export function runMute(args: string[], cwd: string): number {
  const muted = desiredState(args[0], cwd);
  const path = muteFlagPath(cwd);
  if (muted) {
    createFlag(path);
  } else {
    removeFlag(path);
  }
  const label = projectLabel(cwd);
  const message = muted ? `hollr: muted ${label}` : `hollr: unmuted ${label}`;
  process.stdout.write(`${message}\n`);
  return EXIT_OK;
}
