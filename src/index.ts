#!/usr/bin/env node
/**
 * hollr CLI entry point: a hand-rolled subcommand dispatch (no arg-parse
 * dependency). `run(argv)` returns the process exit code; `main(argv)` adds the
 * top-level error boundary, and the direct-execution guard turns that into
 * `process.exit`. The `emit` path is wrapped (`runEmitSafe`) so any throw
 * degrades to exit 0 — a hook must never break an agent turn. Every OTHER
 * command surfaces failures: a throw reaches `main`, which writes the error to
 * stderr and exits non-zero rather than masking a real failure as success.
 */

import { fileURLToPath } from "node:url";

import { adapters } from "./adapters/registry.ts";
import { pauseReading, resumeReading, stopReading } from "./core/control.ts";
import { allRequiredOk, checkAll, type Check } from "./core/doctor.ts";
import type { EmitDeps } from "./cli/emit.ts";
import { MAX_STDIN_BYTES, runEmit } from "./cli/emit.ts";
import { runMute } from "./cli/mute.ts";
import {
  selectPlatform,
  spawnDetached,
  whichOnPath,
} from "./platform/index.ts";
import { speakSequenced } from "./platform/sequencer.ts";
import { fireWebhooks } from "./sinks/webhook.ts";

/**
 * Replaced at build time by tsup's `define` with the version from package.json.
 * At test time vitest injects the same value via its `define` config.
 */
declare const __HOLLR_VERSION__: string;

const CLI_NAME = "hollr";

const EXIT_OK = 0;
const EXIT_REQUIRED_FAIL = 1;
/** Generic failure of a non-emit (interactive) command; must surface, not hide. */
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const USAGE =
  "usage: hollr <emit|pause|resume|stop|mute|doctor> [options] " +
  "(--version for version)";

const MARK_OK = "✔";
const MARK_MISSING = "✖";

export const VERSION: string = __HOLLR_VERSION__;

/** Human-readable version banner, e.g. `hollr 0.2.0`. */
export function getVersionString(): string {
  return `${CLI_NAME} ${VERSION}`;
}

/**
 * Real, production emit dependencies (live sinks + a capped stdin reader). The
 * webhook sink is fire-and-collect: `webhooks` starts delivery and stores the
 * promise, `awaitWebhooks` exposes it so `runEmit` can drain it (≤6s) before
 * exit — otherwise process exit would kill in-flight network deliveries.
 */
function realEmitDeps(): EmitDeps {
  let pendingWebhooks: Promise<void> = Promise.resolve();
  return {
    readStdin,
    platform: selectPlatform(),
    speak: speakSequenced,
    notify: (argv) => {
      spawnDetached(argv);
    },
    webhooks: (ev, targets, allowHttp) => {
      pendingWebhooks = fireWebhooks(ev, targets, { allowHttp });
    },
    awaitWebhooks: () => pendingWebhooks,
  };
}

/** Read stdin fully, capped at {@link MAX_STDIN_BYTES} to bound memory. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) {
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Run emit but never propagate a throw — a broken hook must not break the agent. */
async function runEmitSafe(args: string[]): Promise<number> {
  try {
    return await runEmit(args, realEmitDeps());
  } catch {
    return EXIT_OK;
  }
}

/** Print a control result line and return success. */
function emitControl(message: string): number {
  process.stdout.write(`${message}\n`);
  return EXIT_OK;
}

/** Run every prerequisite check, print it, and return the overall verdict. */
async function runDoctor(): Promise<number> {
  const checks = await checkAll({
    which: whichOnPath,
    platform: selectPlatform(),
    adapters,
  });
  for (const check of checks) {
    printCheck(check);
  }
  return allRequiredOk(checks) ? EXIT_OK : EXIT_REQUIRED_FAIL;
}

function printCheck(check: Check): void {
  const mark = check.ok ? MARK_OK : MARK_MISSING;
  process.stdout.write(`${mark} ${check.label} — ${check.detail}\n`);
  if (!check.ok && check.fix !== null) {
    process.stdout.write(`    fix: ${check.fix}\n`);
  }
}

/** Dispatch `hollr <cmd> [...]`; returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "--version":
    case "-v":
      return emitControl(getVersionString());
    case "emit":
      return runEmitSafe(rest);
    case "pause":
      return emitControl(pauseReading());
    case "resume":
      return emitControl(resumeReading());
    case "stop":
      return emitControl(stopReading());
    case "mute":
      return runMute(rest, process.cwd());
    case "doctor":
      return runDoctor();
    default:
      process.stderr.write(`${USAGE}\n`);
      return EXIT_USAGE;
  }
}

/**
 * Top-level error boundary. `emit` is already guarded by {@link runEmitSafe},
 * which never rejects (its only work is inside a try that returns
 * {@link EXIT_OK} on catch), so any rejection reaching here is a genuine
 * failure of an interactive command (doctor/mute/pause/resume/stop). Those must
 * surface: write the message to stderr and exit non-zero — never a silent 0.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${CLI_NAME}: ${message}\n`);
    return EXIT_ERROR;
  }
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return entry === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(EXIT_ERROR);
    });
}
