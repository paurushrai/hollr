/**
 * Webhook sink — the ONLY part of hollr that leaves the machine, so it is the
 * privacy + security boundary. {@link webhookPayload} is the single serializer
 * and emits ONLY six metadata fields (never `cwd`, never `lastResponse`, never
 * any code); every provider body derives from those fields plus safe metadata
 * (`agentTitle`, `event`, `project`, `summary`).
 *
 * Delivery never throws: all network, log, and chmod failures are caught and
 * degrade (log or skip), because this runs inside a Claude Code hook.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { EventName, WebhookProvider, WebhookTarget } from "../core/config.ts";
import { hollrHome } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";

const PAYLOAD_VERSION = 1 as const;
const TIMEOUT_MS = 5000;
const LOG_CAP = 100;
const LOG_FILE = "webhook.log";
const CONFIG_FILE = "config.json";
const CONFIG_MODE = 0o600;
const HTTP_SCHEME = "http:";
const HTTPS_SCHEME = "https:";
const PRIORITY_DONE = "default";
const PRIORITY_OTHER = "high";
const CONTENT_TYPE_JSON = "application/json";
const CONTENT_TYPE_FORM = "application/x-www-form-urlencoded";
const PUSHOVER_TOKEN = "token";
const PUSHOVER_USER = "user";
const DONE_EVENT: EventName = "done";
const OUTCOME_OK = "ok";
const OUTCOME_NETWORK_ERROR = "error";
const OUTCOME_SKIP = "skip";
const SKIP_REASON_HTTP = "http-not-allowed";
const SKIP_REASON_UNKNOWN_PROVIDER = "unknown-provider";
const SKIP_REASON_DELIVERY_ERROR = "delivery-error";

/** The exact, exhaustive shape sent off-machine. No other serializer exists. */
export interface WebhookPayload {
  v: 1;
  ts: string;
  agent: string;
  event: EventName;
  project: string;
  summary: string;
}

interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
}

type Attempt =
  | { kind: "ok" }
  | { kind: "http"; status: number }
  | { kind: "network" };

/** Options for {@link fireWebhooks}; `fetchFn`/`logPath` are injectable for tests. */
export interface FireWebhooksOptions {
  allowHttp: boolean;
  fetchFn?: typeof fetch;
  logPath?: string;
}

/**
 * THE privacy boundary: the only serializer of an event for the network. Emits
 * exactly six metadata fields and nothing derived from `cwd` or `lastResponse`.
 */
export function webhookPayload(ev: HollrEvent): WebhookPayload {
  return {
    v: PAYLOAD_VERSION,
    ts: ev.ts,
    agent: ev.agent,
    event: ev.event,
    project: ev.project,
    summary: ev.summary,
  };
}

/** Notification title line — metadata only (`agentTitle`/`event`/`project`). */
function titleLine(ev: HollrEvent): string {
  return `hollr: ${ev.agentTitle} ${ev.event} in ${ev.project}`;
}

function withoutKeys(
  headers: Record<string, string>,
  drop: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!drop.includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

function formatNtfy(ev: HollrEvent, headers: Record<string, string>): WebhookRequest {
  return {
    headers: {
      ...headers,
      Title: titleLine(ev),
      Priority: ev.event === DONE_EVENT ? PRIORITY_DONE : PRIORITY_OTHER,
    },
    body: ev.summary,
  };
}

function formatPushover(
  ev: HollrEvent,
  headers: Record<string, string>,
): WebhookRequest {
  const form = new URLSearchParams();
  const token = headers[PUSHOVER_TOKEN];
  const user = headers[PUSHOVER_USER];
  if (token !== undefined) {
    form.set(PUSHOVER_TOKEN, token);
  }
  if (user !== undefined) {
    form.set(PUSHOVER_USER, user);
  }
  form.set("title", titleLine(ev));
  form.set("message", ev.summary);
  return {
    headers: {
      ...withoutKeys(headers, [PUSHOVER_TOKEN, PUSHOVER_USER]),
      "content-type": CONTENT_TYPE_FORM,
    },
    body: form.toString(),
  };
}

function formatSlack(ev: HollrEvent, headers: Record<string, string>): WebhookRequest {
  return {
    headers: { ...headers, "content-type": CONTENT_TYPE_JSON },
    body: JSON.stringify({ text: `${titleLine(ev)} — ${ev.summary}` }),
  };
}

function formatGeneric(
  ev: HollrEvent,
  headers: Record<string, string>,
): WebhookRequest {
  return {
    headers: { ...headers, "content-type": CONTENT_TYPE_JSON },
    body: JSON.stringify(webhookPayload(ev)),
  };
}

const FORMATTERS: Record<
  WebhookProvider,
  (ev: HollrEvent, headers: Record<string, string>) => WebhookRequest
> = {
  ntfy: formatNtfy,
  pushover: formatPushover,
  slack: formatSlack,
  generic: formatGeneric,
};

/** Only `https:` is always allowed; `http:` needs the opt-in; else rejected. */
function urlAllowed(url: string, allowHttp: boolean): boolean {
  try {
    const scheme = new URL(url).protocol;
    if (scheme === HTTPS_SCHEME) {
      return true;
    }
    if (scheme === HTTP_SCHEME) {
      return allowHttp;
    }
    return false;
  } catch {
    return false;
  }
}

/** One POST attempt with a hard timeout; classifies the outcome for the caller. */
async function tryOnce(
  url: string,
  req: WebhookRequest,
  fetchFn: typeof fetch,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    return res.ok ? { kind: "ok" } : { kind: "http", status: res.status };
  } catch {
    return { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver with ONE retry on network error/timeout only; 4xx/5xx never retry. */
async function attemptDelivery(
  ev: HollrEvent,
  target: WebhookTarget,
  req: WebhookRequest,
  fetchFn: typeof fetch,
): Promise<string> {
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await tryOnce(target.url, req, fetchFn);
    if (result.kind === "ok") {
      return logLine(ev, OUTCOME_OK, target.name);
    }
    if (result.kind === "http") {
      return logLine(ev, String(result.status), target.name);
    }
  }
  return logLine(ev, OUTCOME_NETWORK_ERROR, target.name);
}

async function deliverTarget(
  ev: HollrEvent,
  target: WebhookTarget,
  allowHttp: boolean,
  fetchFn: typeof fetch,
): Promise<string> {
  if (!urlAllowed(target.url, allowHttp)) {
    return logLine(ev, OUTCOME_SKIP, target.name, SKIP_REASON_HTTP);
  }
  const formatter = FORMATTERS[target.provider];
  if (formatter === undefined) {
    return logLine(ev, OUTCOME_SKIP, target.name, SKIP_REASON_UNKNOWN_PROVIDER);
  }
  const req = formatter(ev, target.headers ?? {});
  return attemptDelivery(ev, target, req, fetchFn);
}

/**
 * Isolate one target: any unexpected throw becomes a logged skip line so a
 * single malformed sibling can never reject the batch (see {@link fireWebhooks}).
 */
async function deliverTargetSafe(
  ev: HollrEvent,
  target: WebhookTarget,
  allowHttp: boolean,
  fetchFn: typeof fetch,
): Promise<string> {
  try {
    return await deliverTarget(ev, target, allowHttp, fetchFn);
  } catch {
    return logLine(ev, OUTCOME_SKIP, target.name, SKIP_REASON_DELIVERY_ERROR);
  }
}

/** A target matches only when `events` is a real array containing the event. */
function targetMatches(target: WebhookTarget, event: EventName): boolean {
  return Array.isArray(target.events) && target.events.includes(event);
}

function logLine(
  ev: HollrEvent,
  status: string,
  name: string,
  reason?: string,
): string {
  const base = `${ev.ts} ${status} ${name}`;
  return reason === undefined ? base : `${base} ${reason}`;
}

function readLogLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

/** Append outcome lines, keeping only the last {@link LOG_CAP}; best-effort. */
function appendLog(path: string, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const all = [...readLogLines(path), ...lines].slice(-LOG_CAP);
    writeFileSync(path, `${all.join("\n")}\n`);
  } catch {
    // The webhook log is best-effort telemetry; a write failure is not fatal.
  }
}

/**
 * Fire every target whose `events` include `ev.event`. Filters, formats per
 * provider, enforces the HTTPS boundary, delivers (5s timeout, one retry on
 * network error only), and appends outcome lines. Never rejects.
 */
export async function fireWebhooks(
  ev: HollrEvent,
  targets: WebhookTarget[],
  opts: FireWebhooksOptions,
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const logPath = opts.logPath ?? join(hollrHome(), LOG_FILE);
  const matched = targets.filter((target) => targetMatches(target, ev.event));
  const lines = await Promise.all(
    matched.map((target) => deliverTargetSafe(ev, target, opts.allowHttp, fetchFn)),
  );
  appendLog(logPath, lines);
}

/**
 * Config hardening: when ANY target carries `headers` (auth tokens live there),
 * chmod the global `config.json` to 0600. Best-effort — a chmod failure never
 * propagates. No-op when no target has headers.
 */
export function hardenConfig(targets: WebhookTarget[]): void {
  const hasSecrets = targets.some(
    (target) => target.headers !== undefined && Object.keys(target.headers).length > 0,
  );
  if (!hasSecrets) {
    return;
  }
  try {
    chmodSync(join(hollrHome(), CONFIG_FILE), CONFIG_MODE);
  } catch {
    // Hardening is best-effort; a missing/locked config must not break the hook.
  }
}
