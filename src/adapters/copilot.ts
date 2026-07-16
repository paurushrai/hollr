/**
 * The copilot adapter — wires GitHub Copilot CLI to kelbrin.
 *
 * Verified integration points (docs.github.com/en/copilot/reference/hooks-reference
 * and .../how-tos/copilot-cli/customize-copilot/use-hooks, fetched 2026-07-11):
 *   - User-level hooks live in `~/.copilot/hooks/<name>.json` (Copilot loads every
 *     `*.json` in that dir). kelbrin owns a dedicated `kelbrin.json` so it never
 *     clobbers other hook files. Schema: `{ version: 1, hooks: { <event>: [...] } }`
 *     where each handler is `{ type: "command", command, matcher? }` and `command`
 *     is the cross-platform fallback. Payloads arrive on STDIN as JSON.
 *   - `agentStop` fires when the main agent finishes a turn → kelbrin "done".
 *   - `notification` fires with a `notification_type` (e.g. `agent_idle`,
 *     `permission_prompt`, `elicitation_dialog`) → kelbrin "blocked". A `matcher`
 *     regex limits it to the "needs the human" types.
 *   - Camel-case event names select the camelCase payload format: `cwd`,
 *     `transcriptPath` (agentStop only), `message` (notification). `transcriptPath`
 *     points to the session `events.jsonl`; assistant turns are `assistant.message`
 *     lines shaped `{ type, timestamp, data }`. The text field within `data` is not
 *     yet officially documented, so read-aloud extracts it defensively.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw. `wire` goes through {@link wireJsonFile} so every change is
 * previewable; `unwire` is surgical — {@link unwireJsonFile} strips only
 * kelbrin's own agentStop/notification entries via {@link removeKelbrinHooks}, so
 * edits a user makes after wiring survive.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { KelbrinEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireCreatedFile, unwireJsonFile, wireJsonFile } from "./diffwire.ts";
import { legacyCommandVariant, removeKelbrinHooks } from "./hooks.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "copilot";
const TITLE = "GitHub Copilot";
const BINARY = "copilot";
const CONFIG_DIR = ".copilot";
const HOOKS_DIR = "hooks";
const HOOKS_FILE = "kelbrin.json";
/** Hooks file written by pre-rename (hollr) versions. */
const LEGACY_HOOKS_FILE = "hollr.json";
const LEDGER_KEY = "copilot:hooks";

/** Cap on the transcript tail we read; mirrors claude-code. */
const MAX_TRANSCRIPT_BYTES = 2_000_000;

const HOOKS_VERSION = 1;
const HOOK_AGENT_STOP = "agentStop";
const HOOK_NOTIFICATION = "notification";
const HOOK_TYPE_COMMAND = "command";
const ASSISTANT_EVENT = "assistant.message";

/** Notification types that mean "the agent is waiting on the human". */
const BLOCKED_MATCHER = "agent_idle|permission_prompt|elicitation_dialog";

const DONE_COMMAND = "kelbrin emit --agent copilot --event done --payload-stdin";
const BLOCKED_COMMAND =
  "kelbrin emit --agent copilot --event blocked --payload-stdin";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hooksPath(deps: AdapterDeps): string {
  return join(deps.home, CONFIG_DIR, HOOKS_DIR, HOOKS_FILE);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- transcript read-aloud --------------------------------------------------

/** Read the final ≤ {@link MAX_TRANSCRIPT_BYTES} of `path`; `null` on any error. */
function readTail(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Join `content` text blocks (`{ type: "text", text }`) into a string. */
function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is JsonObject => isRecord(block))
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join(" ");
}

/**
 * Extract assistant text from a `data` object. The field is undocumented, so
 * try the plausible shapes: a `text`/`content`/`message` string, or a `content`
 * array of text blocks. Returns `""` when none carry text.
 */
function textFromData(data: JsonObject): string {
  if (typeof data.text === "string") {
    return data.text;
  }
  if (typeof data.content === "string") {
    return data.content;
  }
  if (typeof data.message === "string") {
    return data.message;
  }
  return joinTextBlocks(data.content);
}

/** Extract assistant text from a single `assistant.message` JSONL line, else `null`. */
function assistantText(line: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== ASSISTANT_EVENT || !isRecord(obj.data)) {
    return null;
  }
  const text = textFromData(obj.data).trim();
  return text.length > 0 ? text : null;
}

// --- wiring -----------------------------------------------------------------

/** A kelbrin command handler for `event`, optionally filtered by `matcher`. */
function commandHandler(command: string, matcher?: string): JsonObject {
  const handler: JsonObject = { type: HOOK_TYPE_COMMAND, command };
  if (matcher !== undefined) {
    handler.matcher = matcher;
  }
  return handler;
}

/** Append kelbrin's handler for `command` unless an entry already carries it. */
function appendHandler(
  existing: unknown,
  command: string,
  matcher?: string,
): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  if (list.some((entry) => isRecord(entry) && entry.command === command)) {
    return list;
  }
  return [...list, commandHandler(command, matcher)];
}

/**
 * Idempotent mutation adding the agentStop/notification handlers while preserving
 * `version`, every unrelated hook event, and any pre-existing handlers.
 */
function addHooks(json: JsonObject): JsonObject {
  const hooks = isRecord(json.hooks) ? json.hooks : {};
  return {
    ...json,
    version: typeof json.version === "number" ? json.version : HOOKS_VERSION,
    hooks: {
      ...hooks,
      [HOOK_AGENT_STOP]: appendHandler(hooks[HOOK_AGENT_STOP], DONE_COMMAND),
      [HOOK_NOTIFICATION]: appendHandler(
        hooks[HOOK_NOTIFICATION],
        BLOCKED_COMMAND,
        BLOCKED_MATCHER,
      ),
    },
  };
}

// --- surgical unwire ---------------------------------------------------------

/**
 * The hook commands kelbrin's own wiring can append, plus the pre-rename
 * (hollr) forms old installs wrote — both count as ours for strip/unwire.
 */
const KELBRIN_COMMANDS: ReadonlySet<string> = new Set([
  DONE_COMMAND,
  BLOCKED_COMMAND,
  legacyCommandVariant(DONE_COMMAND),
  legacyCommandVariant(BLOCKED_COMMAND),
]);

/** True for an agentStop/notification entry carrying one of kelbrin's own commands. */
function isKelbrinEntry(entry: unknown): boolean {
  return (
    isRecord(entry) && typeof entry.command === "string" && KELBRIN_COMMANDS.has(entry.command)
  );
}

/** Strip kelbrin's agentStop/notification entries, preserving everything else. */
function removeHooks(json: JsonObject): JsonObject {
  return removeKelbrinHooks(json, [HOOK_AGENT_STOP, HOOK_NOTIFICATION], isKelbrinEntry);
}

// --- adapter ----------------------------------------------------------------

export const copilot: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "GitHub Copilot CLI — agentStop/notification hooks and read-aloud",
  capabilities: {
    done: true,
    blocked: true,
    readAloud: true,
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
    const op = wireJsonFile(hooksPath(deps), addHooks, LEDGER_KEY);
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
    // Whole-file delete is safe for the legacy file: hollr created it whole.
    unwireCreatedFile(join(deps.home, CONFIG_DIR, HOOKS_DIR, LEGACY_HOOKS_FILE), LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): KelbrinEvent | null {
    if (!isRecord(raw)) {
      return null;
    }
    const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
    return {
      v: 1,
      ts: new Date().toISOString(),
      agent: ID,
      agentTitle: TITLE,
      event: eventHint,
      cwd,
      project: projectLabel(cwd),
      summary: typeof raw.message === "string" ? raw.message : "",
    };
  },

  readLastResponse(raw: unknown): Promise<string | null> {
    if (!isRecord(raw) || typeof raw.transcriptPath !== "string") {
      return Promise.resolve(null);
    }
    const data = readTail(raw.transcriptPath);
    if (data === null) {
      return Promise.resolve(null);
    }
    const lines = data.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const text = assistantText(lines[index] ?? "");
      if (text !== null) {
        return Promise.resolve(text);
      }
    }
    return Promise.resolve(null);
  },
};
