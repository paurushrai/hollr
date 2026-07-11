/**
 * `hollr emit` entry point: parse the emit flags, resolve an optional payload
 * (stdin or argv, JSON, defensively), normalize it into a {@link HollrEvent}
 * with a built-in generic normalizer, and hand it to the router.
 *
 * This runs inside a Claude Code hook, so it must never crash an agent turn:
 * every payload parse degrades to `{}` and the caller (`src/index.ts`) wraps
 * this in a top-level try/catch that forces exit 0.
 */

import type { EventName } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { route } from "../core/router.ts";
import type { Platform } from "../platform/index.ts";
import type { speakSequenced } from "../platform/sequencer.ts";

/** Hard cap on stdin payload size; anything larger is ignored (payload = {}). */
export const MAX_STDIN_BYTES = 1024 * 1024;

/** Parsed `hollr emit` flags. `event` is unvalidated here (route tolerates it). */
export interface EmitFlags {
  agent: string;
  event: string;
  summary: string | null;
  payloadStdin: boolean;
  payloadArgv: string | null;
}

/**
 * Injected dependencies so `runEmit` is unit-testable: `readStdin` supplies the
 * raw payload, and the sink trio + platform are passed straight to the router.
 * `loadConfig`/`route` are imported directly and driven via a temp `HOLLR_HOME`.
 */
export interface EmitDeps {
  readStdin(): Promise<string>;
  platform: Platform;
  speak: typeof speakSequenced;
  notify(argv: string[]): void;
  webhooks(ev: HollrEvent): void;
}

const EMPTY_PAYLOAD = "{}";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSON object defensively; any failure or non-object yields `{}`. */
function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Hand-rolled flag parser (no arg-parse dependency, argv arrays only). */
function parseEmitFlags(args: string[]): EmitFlags {
  const flags: EmitFlags = {
    agent: "",
    event: "",
    summary: null,
    payloadStdin: false,
    payloadArgv: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--payload-stdin") {
      flags.payloadStdin = true;
      continue;
    }
    index += consumeValueFlag(flags, arg, args[index + 1]);
  }
  return flags;
}

/** Apply a `--flag <value>` pair; returns 1 if a value was consumed, else 0. */
function consumeValueFlag(
  flags: EmitFlags,
  flag: string | undefined,
  value: string | undefined,
): number {
  switch (flag) {
    case "--agent":
      flags.agent = value ?? "";
      return 1;
    case "--event":
      flags.event = value ?? "";
      return 1;
    case "--summary":
      flags.summary = value ?? null;
      return 1;
    case "--payload-argv":
      flags.payloadArgv = value ?? null;
      return 1;
    default:
      return 0;
  }
}

/** Resolve the raw payload string: stdin (capped), argv JSON, or `{}`. */
async function resolvePayloadRaw(
  flags: EmitFlags,
  deps: EmitDeps,
): Promise<string> {
  if (flags.payloadStdin) {
    const raw = await deps.readStdin();
    return Buffer.byteLength(raw, "utf8") > MAX_STDIN_BYTES ? EMPTY_PAYLOAD : raw;
  }
  if (flags.payloadArgv !== null) {
    return flags.payloadArgv;
  }
  return EMPTY_PAYLOAD;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Generic normalizer used until per-agent adapters land (T9): the agent id
 * doubles as the title, `cwd` comes from the payload or the process, and the
 * summary prefers the `--summary` flag over the payload.
 */
export function buildEmitEvent(
  flags: EmitFlags,
  payload: Record<string, unknown>,
  now: Date,
): HollrEvent {
  const cwd = stringField(payload.cwd, process.cwd());
  const lastResponse =
    typeof payload.lastResponse === "string" ? payload.lastResponse : null;
  return {
    v: 1,
    ts: now.toISOString(),
    agent: flags.agent,
    agentTitle: flags.agent,
    event: flags.event as EventName,
    cwd,
    project: projectLabel(cwd),
    summary: flags.summary ?? stringField(payload.summary, ""),
    lastResponse,
  };
}

/** Parse, normalize, and route an emit; returns the router's exit code. */
export async function runEmit(args: string[], deps: EmitDeps): Promise<number> {
  const flags = parseEmitFlags(args);
  const payload = parseJsonObject(await resolvePayloadRaw(flags, deps));
  const event = buildEmitEvent(flags, payload, new Date());
  return route(
    event,
    loadConfig(event.cwd),
    {
      platform: deps.platform,
      speak: deps.speak,
      notify: deps.notify,
      webhooks: deps.webhooks,
    },
    new Date(),
  );
}
