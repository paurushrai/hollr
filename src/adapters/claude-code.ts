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
import { unwireFromLedger, wireJsonFile, wireTextFile } from "./diffwire.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "claude-code";
const TITLE = "Claude Code";
const LEDGER_KEY = "claude-code:settings";
const COMMAND_LEDGER_KEY = "claude-code:command";

const COMMANDS_DIR = "commands";
const COMMAND_FILE = "hollr.md";
const HOOKS_KEY = "hooks";
const ENABLED_PLUGINS_KEY = "enabledPlugins";

/**
 * The `/hollr` custom slash command hollr owns. Claude Code substitutes
 * `$ARGUMENTS` with the user's text, and the body instructs Claude to run the
 * global `hollr` CLI and relay its output. `init` is deliberately excluded — it
 * is an interactive terminal-only wizard, not a slash-command action. Managed by
 * hollr and fully reversible via `hollr uninstall`.
 */
const COMMAND_TEMPLATE = `---
description: Control hollr (pause/resume/stop/status/mute/doctor)
---

Managed by hollr — reversible via \`hollr uninstall\`. Do not edit by hand.

Run this shell command and relay its output to the user verbatim:

\`\`\`bash
hollr $ARGUMENTS
\`\`\`

Supported actions: pause, resume, stop, status, mute, doctor.

Note: \`hollr init\` is terminal-only (an interactive wizard) and is not
available as a slash command — run it directly in your terminal instead.
`;

/** Cap on the transcript tail we read; ports v1 `MAX_TRANSCRIPT_BYTES`. */
const MAX_TRANSCRIPT_BYTES = 2_000_000;

const HOOK_STOP = "Stop";
const HOOK_NOTIFICATION = "Notification";
const HOOK_TYPE_COMMAND = "command";
const ASSISTANT_TYPE = "assistant";
const TEXT_TYPE = "text";

/** The `blocked` event; the only path the notification-type filter applies to. */
const BLOCKED_EVENT: EventName = "blocked";
/** The `done` event; the only path the background-work filter applies to. */
const DONE_EVENT: EventName = "done";
/** Payload key Claude Code stamps on every Notification hook call. */
const NOTIFICATION_TYPE_KEY = "notification_type";

/**
 * `Stop` hook payload key (Claude Code >= 2.1.145) listing in-flight background
 * tasks so a hook can tell "session done" from "paused, waiting on background
 * work". Each entry has a `type`. Absent on older Claude Code → we never filter.
 */
const BACKGROUND_TASKS_KEY = "background_tasks";
const TASK_TYPE_KEY = "type";

/**
 * Background-task types that mean the turn is NOT really finished — the agent
 * delegated work and is waiting on it, so a `done` announce would be premature.
 * A long-lived `shell` (watcher / dev-server) or `monitor` can run the whole
 * session, so they are deliberately EXCLUDED: counting them would silence every
 * announce. Only actively-delegated work blocks the `done` alert.
 */
const BLOCKING_BACKGROUND_TYPES: ReadonlySet<string> = new Set([
  "subagent",
  "workflow",
  "teammate",
  "cloud session",
]);

/**
 * Notification types that carry no actionable "needs your input" signal, so
 * emitting a `blocked` alert for them is just noise. `idle_prompt` is the 60s
 * idle nag that fires long after the user has stepped away (e.g. after `/clear`,
 * which itself runs no agent turn and so produces no Stop event); `auth_success`
 * is informational; `agent_completed` is a done signal the Stop hook already
 * owns; the terminal `elicitation_*` states are dialog lifecycle, not a prompt.
 *
 * Any type NOT listed here — including a payload that omits the field, as older
 * Claude Code does (anthropics/claude-code#11964) — still notifies, preserving
 * the pre-filter behaviour. So `permission_prompt`, `agent_needs_input`, and
 * `elicitation_dialog` continue to fire.
 */
const SUPPRESSED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "idle_prompt",
  "auth_success",
  "agent_completed",
  "elicitation_complete",
  "elicitation_response",
]);

const STOP_COMMAND =
  "hollr emit --agent claude-code --event done --payload-stdin";
const NOTIFICATION_COMMAND =
  "hollr emit --agent claude-code --event blocked --payload-stdin";

/** v0.1.x Python hook scripts; a hook command referencing one is legacy. */
const LEGACY_SCRIPT_MARKERS = ["hollr_hook.py", "announce-done.py"] as const;
/** The v0.1.x plugin id, recorded under `enabledPlugins` in settings. */
const LEGACY_PLUGIN_ID = "hollr@hollr-marketplace";

/** Substrings that mark a leftover v1 (Python) integration in settings. */
const LEGACY_MARKERS = [
  ...LEGACY_SCRIPT_MARKERS,
  LEGACY_PLUGIN_ID,
] as const;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPath(deps: AdapterDeps): string {
  return join(deps.home, ".claude", "settings.json");
}

function commandPath(deps: AdapterDeps): string {
  return join(deps.home, ".claude", COMMANDS_DIR, COMMAND_FILE);
}

/** Return a shallow copy of `obj` without `key`, preserving key order. */
function omitKey(obj: JsonObject, key: string): JsonObject {
  const rest: JsonObject = {};
  for (const [name, value] of Object.entries(obj)) {
    if (name !== key) {
      rest[name] = value;
    }
  }
  return rest;
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
      // readSync may return a short count on a single call; loop until the whole
      // range is read, else the unfilled tail stays NUL and corrupts the last
      // (newest) assistant line — exactly the one read-aloud wants.
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, start + offset);
        if (read === 0) {
          break;
        }
        offset += read;
      }
      return buffer.subarray(0, offset).toString("utf8");
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

// --- legacy v0.1.x cleanup --------------------------------------------------

/** True when a hook command string references a legacy v1 Python script. */
function commandIsLegacy(command: unknown): boolean {
  return (
    typeof command === "string" &&
    LEGACY_SCRIPT_MARKERS.some((marker) => command.includes(marker))
  );
}

/** True when any of a hook-array entry's commands is a legacy v1 script. */
function isLegacyHookEntry(entry: unknown): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some(
    (hook) => isRecord(hook) && commandIsLegacy(hook.command),
  );
}

/**
 * Drop every legacy hook entry from each event array, preserving unrelated
 * entries; an event emptied by the strip is removed entirely so no orphan key
 * survives. Unrelated events (e.g. PreToolUse) pass through untouched.
 */
function stripLegacyHooks(hooks: JsonObject): JsonObject {
  const cleaned: JsonObject = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      cleaned[event] = entries;
      continue;
    }
    const kept = entries.filter((entry) => !isLegacyHookEntry(entry));
    if (kept.length > 0) {
      cleaned[event] = kept;
    }
  }
  return cleaned;
}

/** Remove the legacy plugin id from `enabledPlugins`, dropping it if emptied. */
function stripLegacyPlugin(json: JsonObject): JsonObject {
  const plugins = json[ENABLED_PLUGINS_KEY];
  if (isRecord(plugins) && LEGACY_PLUGIN_ID in plugins) {
    const rest = omitKey(plugins, LEGACY_PLUGIN_ID);
    return Object.keys(rest).length > 0
      ? { ...json, [ENABLED_PLUGINS_KEY]: rest }
      : omitKey(json, ENABLED_PLUGINS_KEY);
  }
  if (Array.isArray(plugins) && plugins.includes(LEGACY_PLUGIN_ID)) {
    const kept = plugins.filter((item) => item !== LEGACY_PLUGIN_ID);
    return kept.length > 0
      ? { ...json, [ENABLED_PLUGINS_KEY]: kept }
      : omitKey(json, ENABLED_PLUGINS_KEY);
  }
  return json;
}

/** Strip all v0.1.x legacy hooks and the legacy plugin entry from settings. */
function stripLegacy(json: JsonObject): JsonObject {
  const withoutPlugin = stripLegacyPlugin(json);
  const hooks = withoutPlugin[HOOKS_KEY];
  if (!isRecord(hooks)) {
    return withoutPlugin;
  }
  const cleaned = stripLegacyHooks(hooks);
  return Object.keys(cleaned).length > 0
    ? { ...withoutPlugin, [HOOKS_KEY]: cleaned }
    : omitKey(withoutPlugin, HOOKS_KEY);
}

/**
 * The full settings mutation: strip any v0.1.x legacy integration, then add
 * hollr's Stop/Notification hooks. Idempotent — a fully-wired file is unchanged.
 */
function wireSettings(json: JsonObject): JsonObject {
  return addHooks(stripLegacy(json));
}

/** Concatenate the non-empty per-file diffs. */
function joinDiffs(settingsDiff: string, commandDiff: string): string {
  return [settingsDiff, commandDiff].filter((diff) => diff.length > 0).join("\n");
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
    `legacy hollr v1 integration detected in settings (${marker}); ` +
    "`hollr init` removes it as part of wiring (reversible via `hollr uninstall`)"
  );
}

/**
 * True when `raw` is a Notification (`blocked`) payload whose `notification_type`
 * is non-actionable and should produce no event. Scoped to the blocked path so a
 * Stop payload is never filtered; an absent/unknown type is never suppressed.
 */
function isSuppressedNotification(raw: JsonObject, eventHint: EventName): boolean {
  if (eventHint !== BLOCKED_EVENT) {
    return false;
  }
  const type = raw[NOTIFICATION_TYPE_KEY];
  return typeof type === "string" && SUPPRESSED_NOTIFICATION_TYPES.has(type);
}

/**
 * True when a `done` Stop payload still lists in-flight delegated work, so the
 * announce should be held until the truly-final Stop (when `background_tasks`
 * no longer has a blocking-type entry). Scoped to the `done` path; an absent or
 * malformed array (older Claude Code) is never treated as pending, so those
 * users keep today's behaviour.
 */
function hasPendingDelegatedWork(raw: JsonObject, eventHint: EventName): boolean {
  if (eventHint !== DONE_EVENT) {
    return false;
  }
  const tasks = raw[BACKGROUND_TASKS_KEY];
  if (!Array.isArray(tasks)) {
    return false;
  }
  return tasks.some(
    (task) =>
      isRecord(task) &&
      typeof task[TASK_TYPE_KEY] === "string" &&
      BLOCKING_BACKGROUND_TYPES.has(task[TASK_TYPE_KEY]),
  );
}

// --- adapter ----------------------------------------------------------------

export const claudeCode: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "Claude Code — done/blocked hooks and transcript read-aloud",
  capabilities: {
    done: true,
    blocked: true,
    readAloud: true,
    slashCommand: true,
    instructionInjection: true,
  },

  memoryPath(deps: AdapterDeps): string {
    return join(deps.home, ".claude", "CLAUDE.md");
  },

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
    const settingsOp = wireJsonFile(path, wireSettings, LEDGER_KEY);
    const commandOp = wireTextFile(
      commandPath(deps),
      COMMAND_TEMPLATE,
      COMMAND_LEDGER_KEY,
    );
    const result: WireResult = {
      changed: settingsOp.changed || commandOp.changed,
      diff: joinDiffs(settingsOp.diff, commandOp.diff),
      warnings: marker === null ? [] : [legacyMessage(marker)],
    };
    settingsOp.apply();
    commandOp.apply();
    return Promise.resolve(result);
  },

  unwire(_deps: AdapterDeps): Promise<void> {
    unwireFromLedger(LEDGER_KEY);
    unwireFromLedger(COMMAND_LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): HollrEvent | null {
    if (!isRecord(raw)) {
      return null;
    }
    if (isSuppressedNotification(raw, eventHint)) {
      return null;
    }
    if (hasPendingDelegatedWork(raw, eventHint)) {
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
