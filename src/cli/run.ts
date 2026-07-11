/**
 * `hollr run [--announce-stream cursor] -- <cmd> [args...]`: the universal
 * wrapper. It spawns ANY agent command and, when the child exits, emits a hollr
 * event as the `wrapper` pseudo-agent (done on exit 0, error otherwise). This is
 * the documented read-aloud/blocked path for agents whose native hooks cannot
 * deliver it (e.g. Cursor, Amp).
 *
 * Two contracts are sacred:
 *   1. The child owns the terminal. In plain mode stdio is inherited so
 *      interactive agents behave exactly as if run directly; in stream mode
 *      stdout is piped and TEE'd back so the user still sees everything.
 *   2. The child's exit code is the wrapper's exit code — a wrapper or emit
 *      failure is swallowed and never changes it.
 *
 * The argv after `--` is passed VERBATIM to an argv-array spawn (never a shell),
 * so no injection or word-splitting is possible. Effects (spawn, sinks, clock)
 * are injected so the command is unit-testable without real processes or audio.
 */

import { basename } from "node:path";

import type { EventName, WebhookTarget } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { route } from "../core/router.ts";
import type { Platform } from "../platform/index.ts";
import type { speakSequenced } from "../platform/sequencer.ts";
import { hardenConfig } from "../sinks/webhook.ts";
import { settleWebhooks } from "./emit.ts";

const SEPARATOR = "--";
const STREAM_FLAG = "--announce-stream";
const STREAM_FORMAT_CURSOR = "cursor";
/** Cursor's stream-json final event carries the assistant text in `result`. */
const RESULT_EVENT_TYPE = "result";
const RESULT_TEXT_FIELD = "result";
const LINE_SEPARATOR = "\n";

const WRAPPER_AGENT = "wrapper";
const EVENT_DONE: EventName = "done";
const EVENT_ERROR: EventName = "error";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
/** No child code exists when spawn itself fails; mirror shells' "not found". */
const SPAWN_FAILED = 127;
/** The child was terminated by a signal (exit code null); treat as an error. */
const SIGNAL_EXIT_CODE = 1;

const RUN_USAGE =
  "usage: hollr run [--announce-stream cursor] -- <cmd> [args...]";

/** How the child's stdio is wired: fully inherited, or stdout piped for parsing. */
export type StdioMode = "inherit" | "stream";

/** Minimal readable stream surface the stream-mode tee/parser needs. */
interface StreamLike {
  on(event: "data" | "end", listener: (chunk: Buffer) => void): unknown;
}

/** The injected child handle: a spawned process narrowed to what we consume. */
export interface WrapperChild {
  readonly stdout: StreamLike | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Injected effects so `runWrapper` is unit-testable: `spawn` produces the child
 * (tests fake it — no real processes), `out` is the stream-mode tee target, and
 * the sink trio + clock mirror the shared emit assembly in `index.ts`.
 */
export interface WrapperDeps {
  spawn(command: string, args: string[], mode: StdioMode): WrapperChild;
  /** Tee sink for stream mode: receives every stdout chunk (verbatim). */
  out(chunk: string): void;
  cwd: string;
  now(): Date;
  platform: Platform;
  speak: typeof speakSequenced;
  notify(argv: string[]): void;
  webhooks(ev: HollrEvent, targets: WebhookTarget[], allowHttp: boolean): void;
  awaitWebhooks(): Promise<void>;
}

interface ParsedRun {
  streamCursor: boolean;
  command: string;
  commandArgs: string[];
}

interface RunError {
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the optional `--announce-stream <format>` flag from the pre-`--` args. */
function parseStreamFlag(pre: string[]): { cursor: boolean; error?: string } {
  const index = pre.indexOf(STREAM_FLAG);
  if (index === -1) {
    return { cursor: false };
  }
  const value = pre[index + 1];
  if (value !== STREAM_FORMAT_CURSOR) {
    return { cursor: false, error: `unsupported stream format: ${value ?? ""}` };
  }
  return { cursor: true };
}

/** Split argv on the required `--`; everything after it is the verbatim child. */
function parseRunArgs(args: string[]): ParsedRun | RunError {
  const separator = args.indexOf(SEPARATOR);
  if (separator === -1) {
    return { error: "missing `--` before the command" };
  }
  const child = args.slice(separator + 1);
  const command = child[0];
  if (command === undefined) {
    return { error: "no command given after `--`" };
  }
  const stream = parseStreamFlag(args.slice(0, separator));
  if (stream.error !== undefined) {
    return { error: stream.error };
  }
  return { streamCursor: stream.cursor, command, commandArgs: child.slice(1) };
}

/** Parse one NDJSON line for a cursor `result` event; returns its text or null. */
function parseCursorResult(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== RESULT_EVENT_TYPE) {
    return null;
  }
  const text = parsed[RESULT_TEXT_FIELD];
  return typeof text === "string" ? text : null;
}

/**
 * Attach the stream-mode tee + NDJSON parser to the child's stdout. Every chunk
 * is written back out (so the terminal sees everything) and buffered into whole
 * lines; the latest cursor `result` text wins. Returns a getter for the captured
 * text, `null` until (and unless) a result event is seen.
 */
function attachStreamCapture(child: WrapperChild, deps: WrapperDeps): () => string | null {
  let lastResponse: string | null = null;
  let buffer = "";
  const stdout = child.stdout;
  if (stdout === null) {
    return () => lastResponse;
  }
  const consume = (line: string): void => {
    const found = parseCursorResult(line);
    if (found !== null) {
      lastResponse = found;
    }
  };
  stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    deps.out(text);
    buffer += text;
    const parts = buffer.split(LINE_SEPARATOR);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      consume(line);
    }
  });
  stdout.on("end", () => {
    consume(buffer);
    buffer = "";
  });
  return () => lastResponse;
}

/** Build the wrapper's event directly (no adapter normalize): done or error. */
function buildWrapperEvent(
  deps: WrapperDeps,
  command: string,
  exitCode: number,
  lastResponse: string | null,
): HollrEvent {
  const now = deps.now();
  return {
    v: 1,
    ts: now.toISOString(),
    agent: WRAPPER_AGENT,
    agentTitle: basename(command),
    event: exitCode === EXIT_OK ? EVENT_DONE : EVENT_ERROR,
    cwd: deps.cwd,
    project: projectLabel(deps.cwd),
    summary: "",
    lastResponse,
  };
}

/** Route the event through the same path as `hollr emit`, then drain webhooks. */
async function emitEvent(deps: WrapperDeps, event: HollrEvent): Promise<void> {
  const cfg = loadConfig(event.cwd);
  hardenConfig(cfg.webhooks);
  route(
    event,
    cfg,
    {
      platform: deps.platform,
      speak: deps.speak,
      notify: deps.notify,
      webhooks: (ev) => {
        deps.webhooks(ev, cfg.webhooks, cfg.allowHttp);
      },
    },
    deps.now(),
  );
  await settleWebhooks(deps.awaitWebhooks());
}

/**
 * Emit on child exit. Read-aloud text is only attached to a `done` event (the
 * router ignores it for other modes). Any failure is swallowed so it can never
 * change the child's passthrough exit code.
 */
async function finishExit(
  deps: WrapperDeps,
  command: string,
  exitCode: number,
  capture: (() => string | null) | null,
): Promise<void> {
  try {
    const lastResponse = exitCode === EXIT_OK && capture !== null ? capture() : null;
    await emitEvent(deps, buildWrapperEvent(deps, command, exitCode, lastResponse));
  } catch {
    // The child's exit code is sacred: a wrapper/emit failure must not crash it.
  }
}

/** Resolve with the child's exit code once it exits (or fails to spawn). */
function awaitChild(
  child: WrapperChild,
  deps: WrapperDeps,
  command: string,
  capture: (() => string | null) | null,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const done = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      void finishExit(deps, command, code, capture).finally(() => {
        resolve(code);
      });
    };
    child.on("error", () => {
      done(SPAWN_FAILED);
    });
    child.on("exit", (code) => {
      done(code ?? SIGNAL_EXIT_CODE);
    });
  });
}

/**
 * Run `hollr run`: parse argv, spawn the child (verbatim, no shell), and on exit
 * emit a wrapper event. Returns the child's exit code (or a usage code when the
 * required `--` / a valid stream format is missing).
 */
export function runWrapper(args: string[], deps: WrapperDeps): Promise<number> {
  const parsed = parseRunArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`hollr run: ${parsed.error}\n${RUN_USAGE}\n`);
    return Promise.resolve(EXIT_USAGE);
  }
  const mode: StdioMode = parsed.streamCursor ? "stream" : "inherit";
  const child = deps.spawn(parsed.command, parsed.commandArgs, mode);
  const capture = parsed.streamCursor ? attachStreamCapture(child, deps) : null;
  return awaitChild(child, deps, parsed.command, capture);
}
