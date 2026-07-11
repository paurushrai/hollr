/**
 * The cursor adapter — wires the Cursor Agent (`cursor-agent`) CLI to hollr via
 * Cursor Hooks, which Cursor loads from `~/.cursor/hooks.json` and shares across
 * the IDE and the CLI. It maps the `stop` hook to a `done` announcement and the
 * `beforeShellExecution` hook to an (advisory) `blocked` announcement.
 *
 * VERIFIED against Cursor's Hooks docs (cursor.com/docs/hooks, Jul 2026):
 *   - config: `~/.cursor/hooks.json`, shape `{ "version": 1, "hooks": { … } }`;
 *   - entries: arrays of `{ "type": "command", "command": "…" }`;
 *   - payload delivered over STDIN as JSON;
 *   - `stop` payload carries `workspace_roots` (no `cwd`); `beforeShellExecution`
 *     carries both `cwd` and `workspace_roots` (`cwd` may be empty).
 * Cursor has NO dedicated needs-input event, so `beforeShellExecution` is the
 * closest analog to `blocked` — but it fires before EVERY shell command, so the
 * mapping is approximate/advisory, not a true "agent is waiting for you" signal.
 *
 * Cursor's transcript store is an undocumented SQLite database, so
 * {@link readLastResponse} never parses it and always yields `null`; read-aloud
 * for Cursor is delivered by the wrapper stream mode (a separate task), not here.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw: every read degrades defensively. `wire`/`unwire` go through
 * {@link wireJsonFile}/{@link unwireFromLedger} so every change is previewable
 * and byte-reversible.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireFromLedger, wireJsonFile } from "./diffwire.ts";
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
const HOOK_BEFORE_SHELL = "beforeShellExecution";
const HOOK_TYPE_COMMAND = "command";

const STOP_COMMAND = "hollr emit --agent cursor --event done --payload-stdin";
const BLOCKED_COMMAND =
  "hollr emit --agent cursor --event blocked --payload-stdin";

/**
 * Why the `blocked` mapping is warned about at wire time: Cursor exposes no
 * needs-input event, so `beforeShellExecution` (which fires before every shell
 * command) is only an approximate stand-in.
 */
const ADVISORY_WARNING =
  "cursor 'blocked' is approximate/advisory: Cursor has no needs-input event, " +
  "so hollr wires beforeShellExecution, which fires before every shell command";

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

/** Append hollr's `{type, command}` entry to a hook array unless already present. */
function appendHook(existing: unknown, command: string): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  if (list.some((entry) => isRecord(entry) && entry.command === command)) {
    return list;
  }
  return [...list, { type: HOOK_TYPE_COMMAND, command }];
}

/**
 * Idempotent mutation that adds the `stop` and `beforeShellExecution` command
 * hooks, ensuring the required `version` field and preserving every unrelated
 * hook event and any pre-existing entries on the wired events.
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
      [HOOK_BEFORE_SHELL]: appendHook(hooks[HOOK_BEFORE_SHELL], BLOCKED_COMMAND),
    },
  };
}

// --- adapter ----------------------------------------------------------------

export const cursor: Adapter = {
  id: ID,
  title: TITLE,
  tagline:
    "Cursor Agent (cursor-agent) — done via stop hook; blocked is approximate/advisory",
  capabilities: { done: true, blocked: true, readAloud: false, slashCommand: false },

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
    const op = wireJsonFile(hooksPath(deps), addHooks, LEDGER_KEY);
    const result: WireResult = {
      changed: op.changed,
      diff: op.diff,
      warnings: [ADVISORY_WARNING],
    };
    op.apply();
    return Promise.resolve(result);
  },

  unwire(_deps: AdapterDeps): Promise<void> {
    unwireFromLedger(LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): HollrEvent | null {
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
