/**
 * `kelbrin status`: a read-only report of what kelbrin will do for the current
 * project — wired adapters, the effective config, mute + platform capability,
 * and recent activity. It composes existing subsystems and never sends anything.
 *
 * Privacy: the webhook section prints target NAMES only. Secrets live in
 * `url`/`headers` and must never reach stdout, so the formatter never reads them.
 *
 * `formatStatus` is pure (model in, string out); `runStatus` gathers the model
 * from disk/platform and prints it. Both are defensive: a missing ledger, config,
 * or log degrades to "none"/defaults and never throws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { byId } from "../adapters/registry.ts";
import { listWiredKeys } from "../adapters/diffwire.ts";
import type { Activation, EventName, KelbrinConfig, WebhookTarget } from "../core/config.ts";
import {
  kelbrinHome,
  isMuted,
  isProjectEnabled,
  loadConfig,
  quietActive,
  quietUntilPath,
} from "../core/config.ts";
import { projectLabel } from "../core/events.ts";
import type { Platform } from "../platform/index.ts";

const LOG_TAIL = 5;
const WEBHOOK_LOG = "webhook.log";
const EVENTS_LOG = "events.log";
const EXIT_OK = 0;
const NONE = "none";
const UNKNOWN_MODE = "unknown";
const DEFAULT_VOICE = "system default";
const MS_PER_MINUTE = 60_000;
const EVENT_NAMES: readonly EventName[] = ["done", "blocked", "error"];

/** The fully-resolved inputs `formatStatus` renders; nothing here touches disk. */
export interface StatusModel {
  cwd: string;
  config: KelbrinConfig;
  muted: boolean;
  enabled: boolean;
  activation: Activation;
  quiet: { active: boolean; remainingMinutes: number | null };
  canPauseResume: boolean;
  wiredKeys: string[];
  webhookLog: string[];
  eventsLog: string[];
}

/** Injected effects for `runStatus`, so it is testable via a temp KELBRIN_HOME. */
export interface StatusIo {
  cwd: string;
  platform: Platform;
  out(text: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map a ledger key (`<adapterId>:<suffix>`) to its adapter title, else the key. */
function wiredLabel(key: string): string {
  const id = key.split(":")[0] ?? key;
  return byId(id)?.title ?? key;
}

/** Read the effective mode for `event` defensively (config is not validated). */
function eventMode(config: KelbrinConfig, event: EventName): string {
  const events: unknown = config.events;
  if (isRecord(events)) {
    const entry = events[event];
    if (isRecord(entry) && typeof entry.mode === "string") {
      return entry.mode;
    }
  }
  return UNKNOWN_MODE;
}

/** Webhook target NAMES only — never the url or headers (they hold secrets). */
function webhookNames(config: KelbrinConfig): string[] {
  const targets: unknown = config.webhooks;
  if (!Array.isArray(targets)) {
    return [];
  }
  return (targets as WebhookTarget[])
    .map((target) => (isRecord(target) && typeof target.name === "string" ? target.name : ""))
    .filter((name) => name.length > 0);
}

function section(title: string, lines: string[]): string {
  const body = lines.length === 0 ? [`  ${NONE}`] : lines.map((line) => `  ${line}`);
  return [`${title}:`, ...body].join("\n");
}

/**
 * List each wired adapter once. One adapter can own several ledger keys (e.g.
 * claude-code wires `:settings` and `:command`), which all map to the same
 * title, so dedupe the labels rather than printing the adapter per key.
 */
function wiredSection(keys: string[]): string {
  const labels = [...new Set(keys.map(wiredLabel))];
  return section("Wired adapters", labels);
}

function eventsSection(config: KelbrinConfig): string {
  return section(
    "Events",
    EVENT_NAMES.map((event) => `${event}: ${eventMode(config, event)}`),
  );
}

function configSection(config: KelbrinConfig): string {
  const voice = config.voice.name ?? DEFAULT_VOICE;
  return [
    `Voice: ${voice} @ ${config.voice.rateWpm} wpm`,
    `Quiet hours: ${config.quietHours ?? NONE}`,
    `Webhooks: ${webhookNames(config).join(", ") || NONE}`,
  ].join("\n");
}

/** Whether kelbrin applies globally or requires an explicit per-project opt-in. */
function scopeLine(activation: Activation): string {
  return activation === "opt-in"
    ? "Notifications: on only where you turn it on"
    : "Notifications: on in every project";
}

/** This project's effective on/off state, factoring in mute and opt-in scope. */
function projectStateLine(model: StatusModel): string {
  if (model.muted) {
    return "This project: off for this project — run 'kelbrin on' to enable";
  }
  if (model.enabled) {
    return "This project: on for this project";
  }
  if (model.activation === "opt-in") {
    return "This project: not turned on here — run 'kelbrin on' to enable";
  }
  return "This project: on for this project";
}

/** Whether a temporary global quiet is active, and for how much longer. */
function quietLine(quiet: StatusModel["quiet"]): string {
  if (!quiet.active) {
    return "Quiet: no";
  }
  if (quiet.remainingMinutes === null) {
    return "Quiet: quiet until you run 'kelbrin quiet off'";
  }
  return `Quiet: quiet for ${quiet.remainingMinutes} more minutes`;
}

function projectSection(model: StatusModel): string {
  return [
    `Project: ${projectLabel(model.cwd)} (${model.cwd})`,
    scopeLine(model.activation),
    projectStateLine(model),
    quietLine(model.quiet),
    `Pause/resume: ${model.canPauseResume ? "supported" : "unsupported"}`,
  ].join("\n");
}

/** Render the full report. Pure: same model always yields the same string. */
export function formatStatus(model: StatusModel): string {
  return [
    "kelbrin status",
    wiredSection(model.wiredKeys),
    eventsSection(model.config),
    configSection(model.config),
    projectSection(model),
    section("Recent webhook deliveries", model.webhookLog),
    section("Recent events", model.eventsLog),
    "",
  ].join("\n\n");
}

/** Read the last {@link LOG_TAIL} non-empty lines of a log; missing → `[]`. */
function readLogTail(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-LOG_TAIL);
  } catch {
    return [];
  }
}

/** Remaining quiet in ms for a timed quiet; null for indefinite/inactive/elapsed. */
function readQuietRemaining(now: Date): number | null {
  try {
    const raw = readFileSync(quietUntilPath(), "utf8").trim();
    if (!/^-?\d+$/.test(raw)) {
      return null;
    }
    const remaining = Number.parseInt(raw, 10) - now.getTime();
    return remaining > 0 ? remaining : null;
  } catch {
    return null;
  }
}

/** Gather the status model from disk/platform and print the report. */
export function runStatus(io: StatusIo): number {
  const home = kelbrinHome();
  const config = loadConfig(io.cwd);
  const now = new Date();
  const quietMs = readQuietRemaining(now);
  const model: StatusModel = {
    cwd: io.cwd,
    config,
    muted: isMuted(io.cwd),
    enabled: isProjectEnabled(io.cwd),
    activation: config.activation,
    quiet: {
      active: quietActive(now),
      remainingMinutes: quietMs === null ? null : Math.ceil(quietMs / MS_PER_MINUTE),
    },
    canPauseResume: io.platform.canPauseResume,
    wiredKeys: listWiredKeys(),
    webhookLog: readLogTail(join(home, WEBHOOK_LOG)),
    eventsLog: readLogTail(join(home, EVENTS_LOG)),
  };
  io.out(formatStatus(model));
  return EXIT_OK;
}
