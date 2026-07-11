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
const ENABLED_SUFFIX = ".enabled";
const EXIT_OK = 0;

function muteFlagPath(cwd: string): string {
  return join(hollrHome(), PROJECTS_DIR, `${encodeCwd(cwd)}${MUTED_SUFFIX}`);
}

function enabledFlagPath(cwd: string): string {
  return join(hollrHome(), PROJECTS_DIR, `${encodeCwd(cwd)}${ENABLED_SUFFIX}`);
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

/**
 * Set this project on or off by writing one marker and clearing the other, so
 * `.muted` and `.enabled` are never both present. Setting the chosen marker
 * uses `createFlag` (a write failure surfaces); clearing the other is
 * best-effort. Prints the resulting state.
 */
export function setProjectState(on: boolean, cwd: string): number {
  const mutedPath = muteFlagPath(cwd);
  const enabledPath = enabledFlagPath(cwd);
  if (on) {
    createFlag(enabledPath);
    removeFlag(mutedPath);
  } else {
    createFlag(mutedPath);
    removeFlag(enabledPath);
  }
  const label = projectLabel(cwd);
  process.stdout.write(`hollr: ${on ? "on for" : "off for"} ${label}\n`);
  return EXIT_OK;
}

/** Legacy `hollr mute [on|off]`: maps onto {@link setProjectState}. */
export function runMute(args: string[], cwd: string): number {
  const muted = desiredState(args[0], cwd);
  return setProjectState(!muted, cwd);
}
