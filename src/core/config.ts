/**
 * kelbrin configuration (schema v2): defaults, global + per-project merge, mute,
 * quiet hours, and one-time migration from the v1 (Python) config.
 *
 * All loads are defensive — a missing or malformed file contributes nothing and
 * never raises, because this runs inside a Claude Code hook that must not fail.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EventName = "done" | "blocked" | "error";
export type Mode = "announce" | "readaloud" | "notify" | "silent";
export type WebhookProvider = "ntfy" | "pushover" | "slack" | "generic";
export type QuietHoursWebhooks = "fire" | "suppress";
export type Activation = "all" | "opt-in";

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
  /** Command that opens a markdown file (e.g. `open`); "" until set at init. */
  openCommand: string;
}

export interface WebhookTarget {
  name: string;
  provider: WebhookProvider;
  url: string;
  events: EventName[];
  headers?: Record<string, string>;
  /**
   * Per-target opt-in to insecure `http:` delivery. Undefined = deny (falls back
   * to the legacy root `allowHttp` for configs written before this was per-target).
   */
  allowHttp?: boolean;
}

export interface KelbrinConfig {
  version: number;
  activation: Activation;
  events: Record<EventName, EventConfig>;
  voice: VoiceConfig;
  notify: NotifyConfig;
  readaloud: ReadaloudConfig;
  quietHours: string | null;
  quietHoursWebhooks: QuietHoursWebhooks;
  webhooks: WebhookTarget[];
  /**
   * Legacy global http opt-in, kept only as a fallback for a target that has no
   * own `allowHttp`. New setups set the flag per target; this stays `false`.
   */
  allowHttp: boolean;
}

const SCHEMA_VERSION = 2;
const DEFAULT_RATE_WPM = 190;
const DEFAULT_MAX_CHARS = 1200;

export const DEFAULTS: KelbrinConfig = {
  version: SCHEMA_VERSION,
  activation: "all",
  events: {
    done: { mode: "announce" },
    blocked: { mode: "announce" },
    error: { mode: "notify" },
  },
  voice: { name: null, rateWpm: DEFAULT_RATE_WPM },
  notify: { desktop: true, sound: null },
  readaloud: { maxChars: DEFAULT_MAX_CHARS, stripCode: true, openCommand: "" },
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
const ENABLED_SUFFIX = ".enabled";
const QUIET_UNTIL_FILE = "quiet-until";
const QUIET_INDEFINITE = "indefinite";
const INTEGER_RE = /^-?\d+$/;

/** `$KELBRIN_HOME` if set, else legacy `$HOLLR_HOME`, else `~/.config/kelbrin`. */
export function kelbrinHome(): string {
  const override = process.env.KELBRIN_HOME ?? process.env.HOLLR_HOME;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(homedir(), ".config", "kelbrin");
}

/**
 * One-time `~/.config/hollr` → `~/.config/kelbrin` rename (the product was
 * renamed). No-op when an env override is set (the user pinned a location),
 * when the new home already exists, or when there is no legacy dir. A rename
 * failure is swallowed: the CLI then simply starts with a fresh home rather
 * than crashing every command.
 */
export function migrateLegacyHome(): void {
  const override = process.env.KELBRIN_HOME ?? process.env.HOLLR_HOME;
  if (override !== undefined && override.length > 0) {
    return;
  }
  const legacy = join(homedir(), ".config", "hollr");
  const current = join(homedir(), ".config", "kelbrin");
  if (!existsSync(legacy) || existsSync(current)) {
    return;
  }
  try {
    renameSync(legacy, current);
  } catch {
    // Cross-device or permission failure — fall through to a fresh home.
  }
}

/** Match Claude Code's project-dir encoding: non-alphanumerics become '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(NON_ALNUM, "-");
}

/** The OS default command to open a markdown file. */
export function defaultOpenCommand(platformId: NodeJS.Platform = process.platform): string {
  if (platformId === "darwin") {
    return "open";
  }
  if (platformId === "win32") {
    return "start";
  }
  return "xdg-open";
}

function globalConfigPath(): string {
  return join(kelbrinHome(), "config.json");
}

function projectConfigPath(cwd: string): string {
  return join(kelbrinHome(), "projects", `${encodeCwd(cwd)}.json`);
}

function muteFlagPath(cwd: string): string {
  return join(kelbrinHome(), "projects", `${encodeCwd(cwd)}.muted`);
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
export function loadConfig(cwd: string): KelbrinConfig {
  const base = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  const withGlobal = mergeConfig(base, readJsonObject(globalConfigPath()));
  const merged = mergeConfig(withGlobal, readJsonObject(projectConfigPath(cwd)));
  return merged as unknown as KelbrinConfig;
}

/** Setup has run if the global config OR this project's override exists. */
export function isConfigured(cwd: string): boolean {
  return isFile(globalConfigPath()) || isFile(projectConfigPath(cwd));
}

export function isMuted(cwd: string): boolean {
  return isFile(muteFlagPath(cwd));
}

function projectEnabledFlagPath(cwd: string): string {
  return join(kelbrinHome(), "projects", `${encodeCwd(cwd)}${ENABLED_SUFFIX}`);
}

/** True when this project has an explicit on-marker (overrides opt-in default). */
export function isProjectEnabled(cwd: string): boolean {
  return isFile(projectEnabledFlagPath(cwd));
}

/** Path to the global temporary-quiet marker (transient state, not config). */
export function quietUntilPath(): string {
  return join(kelbrinHome(), QUIET_UNTIL_FILE);
}

/**
 * True while a temporary quiet is in effect. The marker holds either
 * `indefinite` or an epoch-ms expiry. Missing, elapsed, or malformed markers
 * read as inactive — never throws, so it is safe to call from the router hook.
 */
export function quietActive(now: Date): boolean {
  let raw: string;
  try {
    raw = readFileSync(quietUntilPath(), "utf8").trim();
  } catch {
    return false;
  }
  if (raw === QUIET_INDEFINITE) {
    return true;
  }
  if (!INTEGER_RE.test(raw)) {
    return false;
  }
  return now.getTime() < Number.parseInt(raw, 10);
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
 * True if kelbrin v2 is already configured: any existing global config OR any
 * project override file under `projects/` counts, since a project override
 * implies setup has run — so we skip v1 migration. That directory is
 * kelbrin-owned, so any stray `*.json` is treated as our own and suppresses it.
 */
function v2ConfigExists(): boolean {
  if (isFile(globalConfigPath())) {
    return true;
  }
  try {
    return readdirSync(join(kelbrinHome(), "projects")).some((entry) =>
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
  config: KelbrinConfig,
  target: EventName,
  source: unknown,
): void {
  if (isPlainObject(source) && isMode(source.mode)) {
    config.events[target] = { mode: source.mode };
  }
}

/** Build a v2 config from a v1 (Python) config object, mapping renamed keys. */
function buildV2FromV1(v1: Record<string, unknown>): KelbrinConfig {
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
  const home = kelbrinHome();
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

const HTTP_SCHEME = "http:";

/** URL scheme (e.g. `http:`), or `null` when the string is not a parseable URL. */
function urlScheme(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * Migrate a legacy global http opt-in to per-target flags. When `allowHttp` is
 * true at the root, every `http://` target that has no explicit flag inherits
 * `allowHttp: true` (preserving exactly what the global flag permitted), then
 * the root flag is cleared so it can never widen a future target. An explicit
 * per-target flag (true or false) is respected. Idempotent and pure: a config
 * whose root flag is already `false` is returned by reference, unchanged.
 */
export function migrateHttpOptIn(config: KelbrinConfig): {
  config: KelbrinConfig;
  changed: boolean;
} {
  if (config.allowHttp !== true) {
    return { config, changed: false };
  }
  const next = structuredClone(config);
  next.allowHttp = false;
  if (Array.isArray(next.webhooks)) {
    for (const target of next.webhooks) {
      if (target.allowHttp === undefined && urlScheme(target.url) === HTTP_SCHEME) {
        target.allowHttp = true;
      }
    }
  }
  return { config: next, changed: true };
}
