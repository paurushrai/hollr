/**
 * `hollr quiet [duration|off]`: a global, self-expiring pause written to the
 * `quiet-until` marker the router reads (`quietActive`). Bare `quiet` is
 * indefinite (until `quiet off`); `quiet 30m` auto-resumes after the duration;
 * `quiet off` resumes now. An unparseable duration surfaces (non-zero exit) so
 * the user is never silently left un-quieted.
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { quietUntilPath } from "../core/config.ts";

const EXIT_OK = 0;
const QUIET_INDEFINITE = "indefinite";
const DURATION_RE = /^(\d+)([smh])$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** Parse `<int><s|m|h>` to milliseconds; null for anything else or a zero span. */
export function parseDuration(spec: string): number | null {
  const match = DURATION_RE.exec(spec);
  if (match === null) {
    return null;
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = UNIT_MS[match[2] ?? ""];
  if (amount <= 0 || unit === undefined) {
    return null;
  }
  return amount * unit;
}

function writeMarker(body: string): void {
  const path = quietUntilPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function clearMarker(): void {
  try {
    unlinkSync(quietUntilPath());
  } catch {
    // Already absent — nothing to resume.
  }
}

/** Apply the requested quiet state and print it in plain words. */
export function runQuiet(args: string[], now: Date): number {
  const arg = args[0];
  if (arg === "off") {
    clearMarker();
    process.stdout.write("hollr: back on\n");
    return EXIT_OK;
  }
  if (arg === undefined) {
    writeMarker(QUIET_INDEFINITE);
    process.stdout.write("hollr: quiet until you run `hollr quiet off`\n");
    return EXIT_OK;
  }
  const ms = parseDuration(arg);
  if (ms === null) {
    throw new Error(`could not understand '${arg}' — try e.g. 30m, 1h, or 90s`);
  }
  writeMarker(String(now.getTime() + ms));
  process.stdout.write(`hollr: quiet for ${arg}\n`);
  return EXIT_OK;
}
