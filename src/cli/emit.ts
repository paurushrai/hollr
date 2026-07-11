/**
 * `hollr emit` entry point: parse the emit flags, resolve an optional payload
 * (stdin or argv, JSON, defensively), normalize it into a {@link HollrEvent}
 * with a built-in generic normalizer, and hand it to the router.
 *
 * This runs inside a Claude Code hook, so it must never crash an agent turn:
 * every payload parse degrades to `{}` and the caller (`src/index.ts`) wraps
 * this in a top-level try/catch that forces exit 0.
 */

import { byId } from "../adapters/registry.ts";
import type { EventName, HollrConfig, WebhookTarget } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { route } from "../core/router.ts";
import type { Platform } from "../platform/index.ts";
import type { speakSequenced } from "../platform/sequencer.ts";
import { hardenConfig } from "../sinks/webhook.ts";

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
  /**
   * Start (do not await) webhook delivery for a routed event. `targets` and
   * `allowHttp` are threaded from the config `runEmit` already loaded, so the
   * sink never re-reads config. The implementation collects the returned
   * promise for {@link EmitDeps.awaitWebhooks} to drain.
   */
  webhooks(ev: HollrEvent, targets: WebhookTarget[], allowHttp: boolean): void;
  /** Resolve when collected webhook deliveries settle (never rejects). */
  awaitWebhooks(): Promise<void>;
}

/**
 * The router returns synchronously and cannot await network I/O, so webhooks it
 * allowed would be killed by process exit. `runEmit` drains them here, bounded
 * by {@link WEBHOOK_CAP_MS}, without moving the mute/quiet gating out of the
 * router. Never throws: a webhook rejection or timeout cannot crash the turn.
 */
const WEBHOOK_CAP_MS = 6000;

function capTimer(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Drain collected webhook deliveries, bounded by {@link WEBHOOK_CAP_MS}. Shared
 * with `hollr test`, which fires the same real webhook sink and must not exit
 * before in-flight deliveries settle. Never rejects.
 */
export async function settleWebhooks(pending: Promise<void>): Promise<void> {
  const cap = capTimer(WEBHOOK_CAP_MS);
  try {
    await Promise.race([pending, cap.promise]);
  } catch {
    // A webhook rejection or timeout must never crash the turn.
  } finally {
    cap.cancel();
  }
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
 * Generic normalizer, used when no registered adapter claims `flags.agent`: the
 * agent id doubles as the title, `cwd` comes from the payload or the process,
 * and the summary prefers the `--summary` flag over the payload.
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

/**
 * Normalize an emit into an event: a registered adapter for `flags.agent`
 * claims it (and may decline with `null`); an unknown id falls back to the
 * built-in {@link buildEmitEvent} generic normalizer.
 */
function normalizeEmit(
  flags: EmitFlags,
  payload: Record<string, unknown>,
  now: Date,
): HollrEvent | null {
  const adapter = byId(flags.agent);
  if (adapter === undefined) {
    return buildEmitEvent(flags, payload, now);
  }
  return adapter.normalize(payload, flags.event as EventName);
}

/** Exit code for a successful emit that produced no event to route. */
const EXIT_NO_EVENT = 0;

const READALOUD_MODE = "readaloud";
/** Readaloud only makes sense once the turn is over, so it is done-only. */
const READALOUD_EVENT: EventName = "done";

/**
 * True when readaloud applies to THIS event: the config asks for it AND it is
 * the done event. Read defensively (config is not value-validated) so a
 * malformed `events` entry can never throw out of the fast path.
 */
function isReadaloudEvent(cfg: HollrConfig, event: EventName): boolean {
  if (event !== READALOUD_EVENT) {
    return false;
  }
  const entry: unknown = cfg.events[event];
  return isRecord(entry) && entry.mode === READALOUD_MODE;
}

/**
 * Hydrate `event.lastResponse` for a readaloud done event by asking the agent's
 * adapter to read its last response (e.g. a transcript tail). Gated on readaloud
 * actually applying so the up-to-2MB transcript read never runs on the fast
 * path; adapters that decline return `null`, and the router falls back to the
 * announce line.
 */
async function hydrateLastResponse(
  flags: EmitFlags,
  event: HollrEvent,
  payload: Record<string, unknown>,
  cfg: HollrConfig,
): Promise<void> {
  if (!isReadaloudEvent(cfg, event.event)) {
    return;
  }
  const adapter = byId(flags.agent);
  if (adapter === undefined) {
    return;
  }
  event.lastResponse = await adapter.readLastResponse(payload);
}

/** Parse, normalize, and route an emit; returns the router's exit code. */
export async function runEmit(args: string[], deps: EmitDeps): Promise<number> {
  const flags = parseEmitFlags(args);
  const payload = parseJsonObject(await resolvePayloadRaw(flags, deps));
  const event = normalizeEmit(flags, payload, new Date());
  if (event === null) {
    return EXIT_NO_EVENT;
  }
  const cfg = loadConfig(event.cwd);
  hardenConfig(cfg.webhooks);
  await hydrateLastResponse(flags, event, payload, cfg);
  const code = route(
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
    new Date(),
  );
  await settleWebhooks(deps.awaitWebhooks());
  return code;
}
