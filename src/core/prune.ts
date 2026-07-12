/**
 * Best-effort age-prune of the read-aloud temp directory. The instruction hollr
 * injects tells the model to write temp .md files here; hollr never creates
 * them, so this sweep is the only cleanup. Runs in the emit path (every turn)
 * and must never throw — a hook must not break the agent turn.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Delete files in `dir` last modified more than `ttlMs` before `now`. */
export function pruneReadaloudDir(dir: string, now: Date, ttlMs: number = DEFAULT_TTL_MS): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // no dir yet, or unreadable — nothing to prune
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      if (stat.isFile() && now.getTime() - stat.mtimeMs > ttlMs) {
        unlinkSync(path);
      }
    } catch {
      // A racing delete or permission error is not fatal; skip this entry.
    }
  }
}
