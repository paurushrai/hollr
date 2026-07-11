#!/usr/bin/env node
import { fileURLToPath } from "node:url";

/**
 * Replaced at build time by tsup's `define` with the version from package.json.
 * At test time vitest injects the same value via its `define` config.
 */
declare const __HOLLR_VERSION__: string;

const CLI_NAME = "hollr";

export const VERSION: string = __HOLLR_VERSION__;

/** Human-readable version banner, e.g. `hollr 0.2.0`. */
export function getVersionString(): string {
  return `${CLI_NAME} ${VERSION}`;
}

/**
 * Resolve the string the CLI should print for the given arguments.
 * The scaffold has no commands yet, so every path returns the version banner;
 * later tasks add real command dispatch here.
 */
export function run(_argv: readonly string[]): string {
  return getVersionString();
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return entry === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  process.stdout.write(`${run(process.argv.slice(2))}\n`);
}
