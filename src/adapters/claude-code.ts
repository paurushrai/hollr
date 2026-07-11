/**
 * The claude-code adapter — the reference adapter the other agents copy. It
 * normalizes Claude Code's hook payloads into a {@link HollrEvent}, reads the
 * last assistant turn from a JSONL transcript for read-aloud (ported from the
 * v1 Python `transcript.last_assistant_message`), and wires Claude Code's own
 * `~/.claude/settings.json` to invoke `hollr emit`.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw: every read degrades defensively. `wire`/`unwire` go through
 * {@link wireJsonFile}/{@link unwireFromLedger} so every change is previewable
 * and byte-reversible.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireFromLedger, wireJsonFile } from "./diffwire.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "claude-code";
const TITLE = "Claude Code";
const LEDGER_KEY = "claude-code:settings";

/** Cap on the transcript tail we read; ports v1 `MAX_TRANSCRIPT_BYTES`. */
const MAX_TRANSCRIPT_BYTES = 2_000_000;

const HOOK_STOP = "Stop";
const HOOK_NOTIFICATION = "Notification";
const HOOK_TYPE_COMMAND = "command";
const ASSISTANT_TYPE = "assistant";
const TEXT_TYPE = "text";

const STOP_COMMAND =
  "hollr emit --agent claude-code --event done --payload-stdin";
const NOTIFICATION_COMMAND =
  "hollr emit --agent claude-code --event blocked --payload-stdin";

/** Substrings that mark a leftover v1 (Python) integration in settings. */
const LEGACY_MARKERS = [
  "hollr_hook.py",
  "announce-done.py",
  "hollr@hollr-marketplace",
] as const;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPath(deps: AdapterDeps): string {
  return join(deps.home, ".claude", "settings.json");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Read a file's text, or `null` when absent/unreadable. Never throws. */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// --- transcript read-aloud (ports v1 lib/transcript.py) ---------------------

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

/** Extract joined text blocks from a single assistant JSONL line, else `null`. */
function assistantText(line: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== ASSISTANT_TYPE) {
    return null;
  }
  const message = obj.message;
  const content = isRecord(message) ? message.content : null;
  if (!Array.isArray(content)) {
    return null;
  }
  const joined = content
    .filter((block): block is JsonObject => isRecord(block) && block.type === TEXT_TYPE)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
  return joined.length > 0 ? joined : null;
}

// --- wiring -----------------------------------------------------------------

/** True when a hook-array entry already carries `command`. */
function entryHasCommand(entry: unknown, command: string): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some((hook) => isRecord(hook) && hook.command === command);
}

/** Append hollr's hook entry for `command` unless it is already present. */
function appendHollrHook(existing: unknown, command: string): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  if (list.some((entry) => entryHasCommand(entry, command))) {
    return list;
  }
  return [...list, { hooks: [{ type: HOOK_TYPE_COMMAND, command }] }];
}

/**
 * Idempotent mutation that appends the Stop/Notification hooks while preserving
 * every unrelated hook group (e.g. PreToolUse) and any pre-existing entries.
 */
function addHooks(json: JsonObject): JsonObject {
  const hooks = isRecord(json.hooks) ? json.hooks : {};
  return {
    ...json,
    hooks: {
      ...hooks,
      [HOOK_STOP]: appendHollrHook(hooks[HOOK_STOP], STOP_COMMAND),
      [HOOK_NOTIFICATION]: appendHollrHook(hooks[HOOK_NOTIFICATION], NOTIFICATION_COMMAND),
    },
  };
}

/** The first legacy marker found in the raw settings text, or `null`. */
function legacyMarker(rawText: string | null): string | null {
  if (rawText === null) {
    return null;
  }
  return LEGACY_MARKERS.find((marker) => rawText.includes(marker)) ?? null;
}

/** Human-readable removal guidance for a detected legacy marker. */
function legacyMessage(marker: string): string {
  return (
    `legacy hollr integration detected in settings (${marker}); ` +
    "remove it after migrating — automatic cleanup lands in a later release"
  );
}

// --- adapter ----------------------------------------------------------------

export const claudeCode: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "Claude Code — done/blocked hooks and transcript read-aloud",
  capabilities: { done: true, blocked: true, readAloud: true, slashCommand: false },

  detect(deps: AdapterDeps): Promise<Detection> {
    const path = settingsPath(deps);
    const installed = isDir(join(deps.home, ".claude")) || deps.which("claude") !== null;
    const marker = legacyMarker(readFileOrNull(path));
    const detection: Detection = { installed };
    if (installed) {
      detection.configPath = path;
    }
    if (marker !== null) {
      detection.degraded = legacyMessage(marker);
    }
    return Promise.resolve(detection);
  },

  wire(deps: AdapterDeps): Promise<WireResult> {
    const path = settingsPath(deps);
    const marker = legacyMarker(readFileOrNull(path));
    const op = wireJsonFile(path, addHooks, LEDGER_KEY);
    const result: WireResult = {
      changed: op.changed,
      diff: op.diff,
      warnings: marker === null ? [] : [legacyMessage(marker)],
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
    if (!isRecord(raw) || typeof raw.transcript_path !== "string") {
      return Promise.resolve(null);
    }
    const data = readTail(raw.transcript_path);
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
