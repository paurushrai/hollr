/**
 * hollr configuration (schema v2): defaults, global + per-project merge, mute,
 * quiet hours, and one-time migration from the v1 (Python) config.
 *
 * All loads are defensive — a missing or malformed file contributes nothing and
 * never raises, because this runs inside a Claude Code hook that must not fail.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EventName = "done" | "blocked" | "error";
export type Mode = "announce" | "readaloud" | "notify" | "silent";
export type WebhookProvider = "ntfy" | "pushover" | "slack" | "generic";
export type QuietHoursWebhooks = "fire" | "suppress";

export interface EventConfig {
  mode: Mode;
}

export interface VoiceConfig {
  name: string | null;
  rateWpm: number;
}

export interface NotifyConfig {
  desktop: boolean;
  sound: string | null;
}

export interface ReadaloudConfig {
  maxChars: number;
  stripCode: boolean;
}

export interface WebhookTarget {
  name: string;
  provider: WebhookProvider;
  url: string;
  events: EventName[];
  headers?: Record<string, string>;
}

export interface HollrConfig {
  version: number;
  events: Record<EventName, EventConfig>;
  voice: VoiceConfig;
  notify: NotifyConfig;
  readaloud: ReadaloudConfig;
  quietHours: string | null;
  quietHoursWebhooks: QuietHoursWebhooks;
  webhooks: WebhookTarget[];
  allowHttp: boolean;
}

const SCHEMA_VERSION = 2;
const DEFAULT_RATE_WPM = 190;
const DEFAULT_MAX_CHARS = 1200;

export const DEFAULTS: HollrConfig = {
  version: SCHEMA_VERSION,
  events: {
    done: { mode: "announce" },
    blocked: { mode: "announce" },
    error: { mode: "notify" },
  },
  voice: { name: null, rateWpm: DEFAULT_RATE_WPM },
  notify: { desktop: true, sound: null },
  readaloud: { maxChars: DEFAULT_MAX_CHARS, stripCode: true },
  quietHours: null,
  quietHoursWebhooks: "fire",
  webhooks: [],
  allowHttp: false,
};

/** Nested keys whose objects merge one level deep (v1 `_merge` semantics). */
const NESTED_KEYS: ReadonlySet<string> = new Set([
  "events",
  "voice",
  "notify",
  "readaloud",
]);

const NON_ALNUM = /[^A-Za-z0-9]/g;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_PER_HOUR = 60;

/** `$HOLLR_HOME` if set, else `~/.config/hollr`. */
export function hollrHome(): string {
  const override = process.env.HOLLR_HOME;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), ".config", "hollr");
}

/** Match Claude Code's project-dir encoding: non-alphanumerics become '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(NON_ALNUM, "-");
}

function globalConfigPath(): string {
  return join(hollrHome(), "config.json");
}

function projectConfigPath(cwd: string): string {
  return join(hollrHome(), "projects", `${encodeCwd(cwd)}.json`);
}

function muteFlagPath(cwd: string): string {
  return join(hollrHome(), "projects", `${encodeCwd(cwd)}.muted`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Read a JSON object defensively; any failure or non-object yields `{}`. */
function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Top-level merge; known nested dicts merge one level deep so a partial
 * override (e.g. only `events.done`) keeps the remaining defaults.
 */
function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (NESTED_KEYS.has(key) && isPlainObject(value) && isPlainObject(current)) {
      merged[key] = { ...current, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Effective config for `cwd`: DEFAULTS ← global ← project. Never throws;
 * malformed or bad-typed inputs degrade to the merged defaults.
 */
export function loadConfig(cwd: string): HollrConfig {
  const base = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  const withGlobal = mergeConfig(base, readJsonObject(globalConfigPath()));
  const merged = mergeConfig(withGlobal, readJsonObject(projectConfigPath(cwd)));
  return merged as unknown as HollrConfig;
}

/** Setup has run if the global config OR this project's override exists. */
export function isConfigured(cwd: string): boolean {
  return isFile(globalConfigPath()) || isFile(projectConfigPath(cwd));
}

export function isMuted(cwd: string): boolean {
  return isFile(muteFlagPath(cwd));
}

function toMinutes(part: string): number | null {
  const match = HHMM.exec(part);
  if (match === null) {
    return null;
  }
  const hours = match[1];
  const minutes = match[2];
  if (hours === undefined || minutes === undefined) {
    return null;
  }
  return Number(hours) * MINUTES_PER_HOUR + Number(minutes);
}

/**
 * True when `now` falls inside `spec` ("HH:MM-HH:MM"); the window may wrap
 * midnight. Null, empty, or otherwise malformed specs return `false`.
 */
export function inQuietHours(spec: string | null, now: Date): boolean {
  if (spec === null || !spec.includes("-")) {
    return false;
  }
  const separator = spec.indexOf("-");
  const start = toMinutes(spec.slice(0, separator));
  const end = toMinutes(spec.slice(separator + 1));
  if (start === null || end === null) {
    return false;
  }
  const current = now.getHours() * MINUTES_PER_HOUR + now.getMinutes();
  if (start <= end) {
    return start <= current && current < end;
  }
  return current >= start || current < end;
}

const V1_CONFIG_RELATIVE = [".claude", "hollr", "config.json"] as const;

/**
 * True if hollr v2 is already configured: any existing global config OR any
 * project override file under `projects/` counts, since a project override
 * implies setup has run — so we skip v1 migration. That directory is
 * hollr-owned, so any stray `*.json` is treated as our own and suppresses it.
 */
function v2ConfigExists(): boolean {
  if (isFile(globalConfigPath())) {
    return true;
  }
  try {
    return readdirSync(join(hollrHome(), "projects")).some((entry) =>
      entry.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

function isMode(value: unknown): value is Mode {
  return (
    value === "announce" ||
    value === "readaloud" ||
    value === "notify" ||
    value === "silent"
  );
}

function applyEventMode(
  config: HollrConfig,
  target: EventName,
  source: unknown,
): void {
  if (isPlainObject(source) && isMode(source.mode)) {
    config.events[target] = { mode: source.mode };
  }
}

/** Build a v2 config from a v1 (Python) config object, mapping renamed keys. */
function buildV2FromV1(v1: Record<string, unknown>): HollrConfig {
  const config = structuredClone(DEFAULTS);
  const voice = v1.voice;
  if (isPlainObject(voice)) {
    if (typeof voice.name === "string" || voice.name === null) {
      config.voice.name = voice.name;
    }
    if (typeof voice.rate_wpm === "number") {
      config.voice.rateWpm = voice.rate_wpm;
    }
  }
  const readaloud = v1.readaloud;
  if (isPlainObject(readaloud)) {
    if (typeof readaloud.max_chars === "number") {
      config.readaloud.maxChars = readaloud.max_chars;
    }
    if (typeof readaloud.strip_code === "boolean") {
      config.readaloud.stripCode = readaloud.strip_code;
    }
  }
  if (typeof v1.quiet_hours === "string" || v1.quiet_hours === null) {
    config.quietHours = v1.quiet_hours;
  }
  const events = v1.events;
  if (isPlainObject(events)) {
    applyEventMode(config, "done", events.done);
    applyEventMode(config, "blocked", events.needs_input);
  }
  return config;
}

/**
 * One-time import of the v1 config (`~/.claude/hollr/config.json`) into the v2
 * global config. Runs only when no v2 config exists (neither global nor any
 * project file), so it never clobbers a real v2 setup. Returns `true` if it
 * wrote a migrated config, else `false`.
 */
export function migrateV1(): boolean {
  if (v2ConfigExists()) {
    return false;
  }
  const v1 = readJsonObject(join(homedir(), ...V1_CONFIG_RELATIVE));
  if (Object.keys(v1).length === 0) {
    return false;
  }
  const home = hollrHome();
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      `${JSON.stringify(buildV2FromV1(v1), null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Setup/first-run must never fail; a write error means migration did not
    // complete, so report that rather than propagating the exception.
    return false;
  }
  return true;
}
