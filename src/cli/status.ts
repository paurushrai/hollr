/**
 * `hollr status`: a read-only report of what hollr will do for the current
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
import type { EventName, HollrConfig, WebhookTarget } from "../core/config.ts";
import { hollrHome, isMuted, loadConfig } from "../core/config.ts";
import { projectLabel } from "../core/events.ts";
import type { Platform } from "../platform/index.ts";

const LOG_TAIL = 5;
const WEBHOOK_LOG = "webhook.log";
const EVENTS_LOG = "events.log";
const EXIT_OK = 0;
const NONE = "none";
const UNKNOWN_MODE = "unknown";
const DEFAULT_VOICE = "system default";
const EVENT_NAMES: readonly EventName[] = ["done", "blocked", "error"];

/** The fully-resolved inputs `formatStatus` renders; nothing here touches disk. */
export interface StatusModel {
  cwd: string;
  config: HollrConfig;
  muted: boolean;
  canPauseResume: boolean;
  wiredKeys: string[];
  webhookLog: string[];
  eventsLog: string[];
}

/** Injected effects for `runStatus`, so it is testable via a temp HOLLR_HOME. */
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
function eventMode(config: HollrConfig, event: EventName): string {
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
function webhookNames(config: HollrConfig): string[] {
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

function wiredSection(keys: string[]): string {
  return section("Wired adapters", keys.map(wiredLabel));
}

function eventsSection(config: HollrConfig): string {
  return section(
    "Events",
    EVENT_NAMES.map((event) => `${event}: ${eventMode(config, event)}`),
  );
}

function configSection(config: HollrConfig): string {
  const voice = config.voice.name ?? DEFAULT_VOICE;
  return [
    `Voice: ${voice} @ ${config.voice.rateWpm} wpm`,
    `Quiet hours: ${config.quietHours ?? NONE}`,
    `Webhooks: ${webhookNames(config).join(", ") || NONE}`,
  ].join("\n");
}

function projectSection(model: StatusModel): string {
  return [
    `Project: ${projectLabel(model.cwd)} (${model.cwd})`,
    `Muted: ${model.muted ? "yes" : "no"}`,
    `Pause/resume: ${model.canPauseResume ? "supported" : "unsupported"}`,
  ].join("\n");
}

/** Render the full report. Pure: same model always yields the same string. */
export function formatStatus(model: StatusModel): string {
  return [
    "hollr status",
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

/** Gather the status model from disk/platform and print the report. */
export function runStatus(io: StatusIo): number {
  const home = hollrHome();
  const model: StatusModel = {
    cwd: io.cwd,
    config: loadConfig(io.cwd),
    muted: isMuted(io.cwd),
    canPauseResume: io.platform.canPauseResume,
    wiredKeys: listWiredKeys(),
    webhookLog: readLogTail(join(home, WEBHOOK_LOG)),
    eventsLog: readLogTail(join(home, EVENTS_LOG)),
  };
  io.out(formatStatus(model));
  return EXIT_OK;
}
