/**
 * The cursor adapter — wires the Cursor Agent (`cursor-agent`) CLI to kelbrin via
 * Cursor Hooks, which Cursor loads from `~/.cursor/hooks.json` and shares across
 * the IDE and the CLI. It maps the `stop` hook to a `done` announcement.
 *
 * Cursor is DONE-ONLY by default. Cursor has NO dedicated needs-input event, and
 * its closest analog (`beforeShellExecution`) fires before EVERY shell command —
 * not when the agent genuinely waits on the human — so wiring it to `blocked`
 * spams false "needs your input" alerts. It is therefore not wired. Read-aloud
 * and blocked come via the wrapper stream mode (a separate task), not here.
 *
 * VERIFIED against Cursor's Hooks docs (cursor.com/docs/hooks, Jul 2026):
 *   - config: `~/.cursor/hooks.json`, shape `{ "version": 1, "hooks": { … } }`;
 *   - entries: arrays of `{ "type": "command", "command": "…" }`;
 *   - payload delivered over STDIN as JSON;
 *   - `stop` payload carries `workspace_roots` (no `cwd`).
 *
 * Cursor's transcript store is an undocumented SQLite database, so
 * {@link readLastResponse} never parses it and always yields `null`.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw: every read degrades defensively. `wire` goes through
 * {@link wireJsonFile} so every change is previewable; `unwire` is surgical —
 * {@link unwireJsonFile} strips only kelbrin's own `stop` entry via
 * {@link removeKelbrinHooks}, so edits a user makes after wiring survive.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { KelbrinEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireJsonFile, wireJsonFile } from "./diffwire.ts";
import { legacyCommandVariant, removeKelbrinHooks } from "./hooks.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "cursor";
const TITLE = "Cursor";
const LEDGER_KEY = "cursor";
const BINARY = "cursor-agent";
const CONFIG_DIR = ".cursor";
const HOOKS_FILE = "hooks.json";

/** Cursor's hooks schema version; VERIFIED as `1` in the current docs. */
const HOOKS_VERSION = 1;
const HOOK_STOP = "stop";
const HOOK_TYPE_COMMAND = "command";

const STOP_COMMAND = "kelbrin emit --agent cursor --event done --payload-stdin";

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

/** First non-empty string in `workspace_roots`, else `""`. */
function firstWorkspaceRoot(raw: JsonObject): string {
  const roots = raw.workspace_roots;
  if (!Array.isArray(roots)) {
    return "";
  }
  const first = roots.find((root) => typeof root === "string" && root.length > 0);
  return typeof first === "string" ? first : "";
}

/**
 * Resolve the event cwd: prefer a non-empty `cwd` (present on
 * `beforeShellExecution`), else fall back to the first `workspace_roots` entry
 * (the only location on `stop`), else `""`. The adapter never invents a cwd.
 */
function resolveCwd(raw: JsonObject): string {
  if (typeof raw.cwd === "string" && raw.cwd.length > 0) {
    return raw.cwd;
  }
  return firstWorkspaceRoot(raw);
}

// --- wiring -----------------------------------------------------------------

/** Append kelbrin's `{type, command}` entry to a hook array unless already present. */
function appendHook(existing: unknown, command: string): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  if (list.some((entry) => isRecord(entry) && entry.command === command)) {
    return list;
  }
  return [...list, { type: HOOK_TYPE_COMMAND, command }];
}

/**
 * Idempotent mutation that adds the `stop` command hook, ensuring the required
 * `version` field and preserving every unrelated hook event and any pre-existing
 * entries on the `stop` event.
 */
function addHooks(json: JsonObject): JsonObject {
  const hooks = isRecord(json.hooks) ? json.hooks : {};
  const version = typeof json.version === "number" ? json.version : HOOKS_VERSION;
  return {
    ...json,
    version,
    hooks: {
      ...hooks,
      [HOOK_STOP]: appendHook(hooks[HOOK_STOP], STOP_COMMAND),
    },
  };
}

// --- surgical unwire ---------------------------------------------------------

/**
 * kelbrin's own command forms — current plus the pre-rename (hollr) one old
 * installs wrote; both count as ours for strip/unwire.
 */
const KELBRIN_COMMANDS: ReadonlySet<string> = new Set([
  STOP_COMMAND,
  legacyCommandVariant(STOP_COMMAND),
]);

/** True for a `stop` entry carrying kelbrin's own command. */
function isKelbrinEntry(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    typeof entry.command === "string" &&
    KELBRIN_COMMANDS.has(entry.command)
  );
}

/** Strip kelbrin's `stop` entry, preserving any foreign entries and every other event. */
function removeHooks(json: JsonObject): JsonObject {
  return removeKelbrinHooks(json, [HOOK_STOP], isKelbrinEntry);
}

// --- adapter ----------------------------------------------------------------

export const cursor: Adapter = {
  id: ID,
  title: TITLE,
  tagline:
    "Cursor Agent (cursor-agent) — done via stop hook (read-aloud/blocked come via the wrapper)",
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
    const op = wireJsonFile(hooksPath(deps), (json) => addHooks(removeHooks(json)), LEDGER_KEY);
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

  normalize(raw: unknown, eventHint: EventName): KelbrinEvent | null {
    if (!isRecord(raw)) {
      return null;
    }
    const cwd = resolveCwd(raw);
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
