/**
 * Mode router: turns one normalized {@link KelbrinEvent} into sink calls (speak,
 * desktop notify, webhooks) according to the effective config. Runs inside a
 * Claude Code hook, so the whole body is crash-proof — any throw returns 0.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KelbrinConfig } from "./config.ts";
import {
  kelbrinHome,
  inQuietHours,
  isConfigured,
  isMuted,
  isProjectEnabled,
  quietActive,
} from "./config.ts";
import type { EventName } from "./config.ts";
import type { KelbrinEvent } from "./events.ts";
import { prepareSpeechText } from "./events.ts";
import type { Platform } from "../platform/index.ts";
import type { speakSequenced } from "../platform/sequencer.ts";

/** Injected sinks + platform, so the router is fully unit-testable. */
export interface RouterDeps {
  platform: Platform;
  speak: typeof speakSequenced;
  notify(argv: string[]): void;
  webhooks(ev: KelbrinEvent): void;
}

const NOTIFY_TITLE = "kelbrin";
const HINT_MESSAGE = "kelbrin: not configured — run kelbrin init\n";
const HINT_MARKER = "hint-shown";
const EVENTS_LOG = "events.log";
const EVENTS_LOG_CAP = 50;
const SUPPRESS = "suppress";

const LINE_BUILDERS: Record<EventName, (agentTitle: string, project: string) => string> = {
  done: (agentTitle, project) => `${agentTitle} response is ready in ${project}`,
  blocked: (agentTitle, project) => `${agentTitle} needs your input in ${project}`,
  error: (agentTitle, project) => `${agentTitle} hit an error in ${project}`,
};

const EXIT_OK = 0;
const EXIT_HINT = 1;

/** Route `ev`; returns a process exit code (1 only for the once-only hint). */
export function route(
  ev: KelbrinEvent,
  cfg: KelbrinConfig,
  deps: RouterDeps,
  now: Date,
): number {
  try {
    if (quietActive(now)) {
      return EXIT_OK;
    }
    if (isMuted(ev.cwd)) {
      return EXIT_OK;
    }
    if (!isConfigured(ev.cwd)) {
      return showHintOnce();
    }
    if (isProjectEnabled(ev.cwd)) {
      dispatchRouted(ev, cfg, deps, now);
      return EXIT_OK;
    }
    if (cfg.activation === "opt-in") {
      return EXIT_OK;
    }
    dispatchRouted(ev, cfg, deps, now);
    return EXIT_OK;
  } catch {
    // A hook must never break the agent turn: swallow any failure.
    return EXIT_OK;
  }
}

/** Print the setup hint exactly once (marker file), returning its exit code. */
function showHintOnce(): number {
  const marker = join(kelbrinHome(), HINT_MARKER);
  if (existsSync(marker)) {
    return EXIT_OK;
  }
  try {
    mkdirSync(kelbrinHome(), { recursive: true });
    writeFileSync(marker, "");
  } catch {
    return EXIT_OK;
  }
  process.stderr.write(HINT_MESSAGE);
  return EXIT_HINT;
}

/** Fire every sink for a configured, non-muted event. */
function dispatchRouted(
  ev: KelbrinEvent,
  cfg: KelbrinConfig,
  deps: RouterDeps,
  now: Date,
): void {
  const quiet = inQuietHours(cfg.quietHours, now);
  fireWebhooks(ev, cfg, deps, quiet);
  fireSinks(ev, cfg, deps, effectiveMode(cfg, ev.event), quiet);
  appendEventLog(ev);
}

/** Webhooks fire for every routed event unless quiet-hours suppression is on. */
function fireWebhooks(
  ev: KelbrinEvent,
  cfg: KelbrinConfig,
  deps: RouterDeps,
  quiet: boolean,
): void {
  if (quiet && cfg.quietHoursWebhooks === SUPPRESS) {
    return;
  }
  deps.webhooks(ev);
}

/** Speak / notify per mode; silent or unknown modes fire no local sinks. */
function fireSinks(
  ev: KelbrinEvent,
  cfg: KelbrinConfig,
  deps: RouterDeps,
  mode: string | undefined,
  quiet: boolean,
): void {
  const line = LINE_BUILDERS[ev.event](ev.agentTitle, ev.project);
  if (mode === "announce" || mode === "readaloud") {
    const spoken = mode === "readaloud" ? readaloudSpeech(ev, cfg, line) : line;
    if (!quiet) {
      speak(deps, cfg, spoken);
    }
    if (cfg.notify.desktop) {
      desktopNotify(deps, line);
    }
  } else if (mode === "notify") {
    if (!quiet && cfg.notify.sound !== null) {
      speak(deps, cfg, ""); // empty text → sequencer plays the sound only
    }
    desktopNotify(deps, line);
  }
}

/** Readaloud speaks the prepared last response, or the announce line if empty. */
function readaloudSpeech(ev: KelbrinEvent, cfg: KelbrinConfig, line: string): string {
  const raw = ev.lastResponse;
  if (raw === null || raw === undefined || raw.length === 0) {
    return line;
  }
  const prepared = prepareSpeechText(raw, cfg.readaloud.maxChars, cfg.readaloud.stripCode);
  return prepared.length > 0 ? prepared : line;
}

function speak(deps: RouterDeps, cfg: KelbrinConfig, text: string): void {
  deps.speak({
    text,
    voice: cfg.voice.name,
    rateWpm: cfg.voice.rateWpm,
    sound: cfg.notify.sound,
    platform: deps.platform,
  });
}

function desktopNotify(deps: RouterDeps, line: string): void {
  const argv = deps.platform.notifyArgv(NOTIFY_TITLE, line);
  if (argv !== null) {
    deps.notify(argv);
  }
}

/** Config is not value-validated, so read the mode defensively. */
function effectiveMode(cfg: KelbrinConfig, event: EventName): string | undefined {
  const mode = readMode(cfg, event);
  if (mode === "readaloud" && event !== "done") {
    return "announce"; // readaloud only makes sense once the turn is over
  }
  return mode;
}

function readMode(cfg: KelbrinConfig, event: EventName): string | undefined {
  const events: unknown = cfg.events;
  if (!isRecord(events)) {
    return undefined;
  }
  const entry = events[event];
  if (!isRecord(entry)) {
    return undefined;
  }
  return typeof entry.mode === "string" ? entry.mode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Append one capped line to events.log; never throws out of the router. */
function appendEventLog(ev: KelbrinEvent): void {
  try {
    const home = kelbrinHome();
    const path = join(home, EVENTS_LOG);
    const line = `${ev.ts} ${ev.agent} ${ev.event} ${ev.project}`;
    mkdirSync(home, { recursive: true });
    const lines = [...readLogLines(path), line].slice(-EVENTS_LOG_CAP);
    writeFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // events.log is best-effort telemetry; failing to write it is not fatal.
  }
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
