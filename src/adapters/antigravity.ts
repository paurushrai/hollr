/**
 * The antigravity adapter — wires Google's `agy` CLI to hollr. It maps agy's
 * single relevant lifecycle event (`Stop`) to a `done` announcement via a native
 * command hook in the global `~/.gemini/hooks.json`.
 *
 * agy is announce-only here: its transcript store is opaque (SQLite/protobuf),
 * so {@link readLastResponse} never parses it and always yields `null`, and only
 * `done` is supported (agy has no needs-input/notification event).
 *
 * CRITICAL — Stop hook stdout contract: agy parses the handler's STDOUT as
 * `{"decision": "continue"|<other>}`; `"continue"` re-enters the loop and HANGS
 * the agent. `hollr emit` prints nothing on the happy path, so the wired command
 * appends `printf '{}'` to guarantee a safe, non-"continue" decision.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw: every read degrades defensively. `wire` goes through
 * {@link wireJsonFile} so every change is previewable; `unwire` is surgical —
 * {@link unwireJsonFile} strips only hollr's own `Stop` handler from the named
 * `"hollr"` entry, so edits a user makes after wiring survive.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireJsonFile, wireJsonFile } from "./diffwire.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "antigravity";
const TITLE = "Antigravity";
const LEDGER_KEY = "antigravity";
const BINARY = "agy";
const CONFIG_DIR = ".gemini";
const HOOKS_FILE = "hooks.json";

/** Named hook entry hollr owns in agy's `hooks.json`; other entries are left untouched. */
const HOOK_NAME = "hollr";
const HOOK_STOP = "Stop";
const HOOK_TYPE_COMMAND = "command";

/**
 * The wired Stop-hook command. The trailing `printf '{}'` is a hard safety
 * requirement: it prints a non-"continue" decision so agy does not re-enter its
 * loop and hang. Do not remove it.
 */
const HOLLR_STOP_COMMAND =
  "hollr emit --agent antigravity --event done --payload-stdin; printf '{}'";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hooksPath(deps: AdapterDeps): string {
  return join(deps.home, CONFIG_DIR, HOOKS_FILE);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** First non-empty string in `workspacePaths`, else `""` (adapter never invents cwd). */
function workspaceCwd(raw: JsonObject): string {
  const paths = raw.workspacePaths;
  if (!Array.isArray(paths)) {
    return "";
  }
  const first = paths[0];
  return typeof first === "string" ? first : "";
}

// --- wiring -----------------------------------------------------------------

/** True when a `Stop` handler array already carries hollr's command. */
function stopHasHollr(stop: unknown): boolean {
  if (!Array.isArray(stop)) {
    return false;
  }
  return stop.some(
    (handler) => isRecord(handler) && handler.command === HOLLR_STOP_COMMAND,
  );
}

/**
 * Idempotent mutation that adds hollr's `Stop` command handler under the named
 * `"hollr"` entry, preserving every other named hook entry and any pre-existing
 * events on the hollr entry itself.
 */
function addStopHook(json: JsonObject): JsonObject {
  const existing = isRecord(json[HOOK_NAME]) ? json[HOOK_NAME] : {};
  const currentStop = Array.isArray(existing[HOOK_STOP]) ? existing[HOOK_STOP] : [];
  const nextStop = stopHasHollr(currentStop)
    ? currentStop
    : [...currentStop, { type: HOOK_TYPE_COMMAND, command: HOLLR_STOP_COMMAND }];
  return {
    ...json,
    [HOOK_NAME]: {
      ...existing,
      [HOOK_STOP]: nextStop,
    },
  };
}

// --- surgical unwire ---------------------------------------------------------

/** True for a `Stop` handler carrying hollr's own command. */
function isHollrEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.command === HOLLR_STOP_COMMAND;
}

/**
 * Strip hollr's own `Stop` handler from the named `"hollr"` entry, preserving
 * any foreign handlers on it and every other top-level named hook entry. Drops
 * the `"hollr"` key once its `Stop` array empties out.
 *
 * agy's on-disk shape is `{ hollr: { Stop: [...] }, <other-named-entry>: {...} }`
 * — a named hook group, not the `{ hooks: { <event>: [...] } }` shape
 * {@link removeHollrHooks} targets — so this can't reuse that shared helper.
 */
function removeHooks(json: JsonObject): JsonObject {
  const existing = json[HOOK_NAME];
  if (!isRecord(existing)) {
    return json;
  }
  const stop = Array.isArray(existing[HOOK_STOP]) ? existing[HOOK_STOP] : [];
  const kept = stop.filter((entry) => !isHollrEntry(entry));
  const nextEntry: JsonObject = { ...existing };
  if (kept.length > 0) {
    nextEntry[HOOK_STOP] = kept;
  } else {
    delete nextEntry[HOOK_STOP];
  }
  if (Object.keys(nextEntry).length === 0) {
    const { [HOOK_NAME]: _drop, ...rest } = json;
    return rest;
  }
  return { ...json, [HOOK_NAME]: nextEntry };
}

// --- adapter ----------------------------------------------------------------

export const antigravity: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "Google's agentic CLI (agy)",
  capabilities: {
    done: true,
    blocked: false,
    readAloud: false,
    slashCommand: false,
    instructionInjection: false,
  },

  detect(deps: AdapterDeps): Promise<Detection> {
    const installed =
      deps.which(BINARY) !== null || isDir(join(deps.home, CONFIG_DIR));
    const detection: Detection = { installed };
    if (installed) {
      detection.configPath = hooksPath(deps);
    }
    return Promise.resolve(detection);
  },

  wire(deps: AdapterDeps): Promise<WireResult> {
    const op = wireJsonFile(hooksPath(deps), addStopHook, LEDGER_KEY);
    const result: WireResult = {
      changed: op.changed,
      diff: op.diff,
      warnings: [],
    };
    op.apply();
    return Promise.resolve(result);
  },

  unwire(deps: AdapterDeps): Promise<void> {
    unwireJsonFile(hooksPath(deps), removeHooks, LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): HollrEvent | null {
    if (!isRecord(raw)) {
      return null;
    }
    const cwd = workspaceCwd(raw);
    return {
      v: 1,
      ts: new Date().toISOString(),
      agent: ID,
      agentTitle: TITLE,
      event: eventHint,
      cwd,
      project: projectLabel(cwd),
      summary: "",
      lastResponse: null,
    };
  },

  readLastResponse(_raw: unknown): Promise<string | null> {
    return Promise.resolve(null);
  },
};
