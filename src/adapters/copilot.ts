/**
 * The copilot adapter — wires GitHub Copilot CLI to hollr.
 *
 * Verified integration points (docs.github.com/en/copilot/reference/hooks-reference
 * and .../how-tos/copilot-cli/customize-copilot/use-hooks, fetched 2026-07-11):
 *   - User-level hooks live in `~/.copilot/hooks/<name>.json` (Copilot loads every
 *     `*.json` in that dir). hollr owns a dedicated `hollr.json` so it never
 *     clobbers other hook files. Schema: `{ version: 1, hooks: { <event>: [...] } }`
 *     where each handler is `{ type: "command", command, matcher? }` and `command`
 *     is the cross-platform fallback. Payloads arrive on STDIN as JSON.
 *   - `agentStop` fires when the main agent finishes a turn → hollr "done".
 *   - `notification` fires with a `notification_type` (e.g. `agent_idle`,
 *     `permission_prompt`, `elicitation_dialog`) → hollr "blocked". A `matcher`
 *     regex limits it to the "needs the human" types.
 *   - Camel-case event names select the camelCase payload format: `cwd`,
 *     `transcriptPath` (agentStop only), `message` (notification). `transcriptPath`
 *     points to the session `events.jsonl`; assistant turns are `assistant.message`
 *     lines shaped `{ type, timestamp, data }`. The text field within `data` is not
 *     yet officially documented, so read-aloud extracts it defensively.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw. `wire`/`unwire` go through the diffwire writers so every change
 * is previewable and byte-reversible.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireFromLedger, wireJsonFile } from "./diffwire.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "copilot";
const TITLE = "GitHub Copilot";
const BINARY = "copilot";
const CONFIG_DIR = ".copilot";
const HOOKS_DIR = "hooks";
const HOOKS_FILE = "hollr.json";
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

const DONE_COMMAND = "hollr emit --agent copilot --event done --payload-stdin";
const BLOCKED_COMMAND =
  "hollr emit --agent copilot --event blocked --payload-stdin";

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

/** A hollr command handler for `event`, optionally filtered by `matcher`. */
function commandHandler(command: string, matcher?: string): JsonObject {
  const handler: JsonObject = { type: HOOK_TYPE_COMMAND, command };
  if (matcher !== undefined) {
    handler.matcher = matcher;
  }
  return handler;
}

/** Append hollr's handler for `command` unless an entry already carries it. */
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

// --- adapter ----------------------------------------------------------------

export const copilot: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "GitHub Copilot CLI — agentStop/notification hooks and read-aloud",
  capabilities: { done: true, blocked: true, readAloud: true, slashCommand: false },

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

  unwire(_deps: AdapterDeps): Promise<void> {
    unwireFromLedger(LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): HollrEvent | null {
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
