/**
 * The codex adapter — wires OpenAI's `codex` CLI to kelbrin.
 *
 * Two verified integration points (docs: learn.chatgpt.com/docs/config-file,
 * learn.chatgpt.com/docs/hooks):
 *   1. `~/.codex/config.toml` top-level `notify = [...]` runs a command on the
 *      `agent-turn-complete` event, passing a single JSON string as the LAST
 *      argv argument. Fields are kebab-case (`cwd`, `last-assistant-message`).
 *      kelbrin wires this to `kelbrin emit ... --payload-argv` (done + read-aloud).
 *   2. `~/.codex/hooks.json` (Claude-style) fires a `PermissionRequest` command
 *      hook, delivering its payload (snake_case `cwd`, `tool_name`) on STDIN.
 *      kelbrin wires this to `kelbrin emit ... --payload-stdin` (blocked). Codex
 *      treats exit 0 with no stdout as "no decision", so kelbrin's silent emit
 *      never allows or denies — it only announces.
 *
 * Read-aloud reads `last-assistant-message` from the notify payload DIRECTLY;
 * the rollout JSONL transcript is mid-migration and is never touched.
 *
 * CAVEAT (surfaced as a wire warning): Codex records hash-based trust for
 * non-managed command hooks, so the blocked hook stays inert until the user
 * reviews and trusts it in Codex.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) a hook and
 * MUST NOT throw. `wire`/`unwire` go through the diffwire writers so every change
 * is previewable and byte-reversible.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { kelbrinHome } from "../core/config.ts";
import type { EventName } from "../core/config.ts";
import type { KelbrinEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireJsonFile, unwireTextFile, wireJsonFile, wireTextFile } from "./diffwire.ts";
import { legacyCommandVariant, removeKelbrinHooks } from "./hooks.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "codex";
const TITLE = "Codex";
const BINARY = "codex";
const CONFIG_DIR = ".codex";
const CONFIG_FILE = "config.toml";
const HOOKS_FILE = "hooks.json";
const CONFIG_LEDGER_KEY = "codex:config";
const HOOKS_LEDGER_KEY = "codex:hooks";

/** Verified notify payload field carrying the assistant's final message. */
const LAST_MESSAGE_FIELD = "last-assistant-message";

/**
 * The `notify` argv kelbrin writes into config.toml. Codex appends the JSON
 * payload as the trailing argv, which `emit`'s `--payload-argv` consumes.
 */
const NOTIFY_ARGV = [
  "kelbrin",
  "emit",
  "--agent",
  "codex",
  "--event",
  "done",
  "--payload-argv",
] as const;

/** hooks.json PermissionRequest command; payload arrives on stdin. */
const BLOCKED_COMMAND =
  "kelbrin emit --agent codex --event blocked --payload-stdin";
const HOOK_EVENT = "PermissionRequest";
const HOOK_TYPE_COMMAND = "command";
/** Matchers are regexes compiled against tool names; `.*` is the catch-all. */
const HOOK_MATCHER = ".*";

/** Non-managed command hooks need explicit trust before Codex runs them. */
const HOOK_TRUST_WARNING =
  "codex requires you to review and trust the blocked hook once " +
  "(run `codex` and approve it) — it stays inert until then";

const NOTIFY_KEY_PATTERN = /^\s*notify\s*=/;
const TABLE_HEADER_PATTERN = /^\s*\[/;
const NEWLINE = "\n";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(deps: AdapterDeps): string {
  return join(deps.home, CONFIG_DIR, CONFIG_FILE);
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

/** Read a file's text, or `null` when absent/unreadable. Never throws. */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// --- config.toml notify patch (line-based, no TOML dependency) --------------

/** The exact `notify` TOML line kelbrin owns. */
function notifyLine(): string {
  const items = NOTIFY_ARGV.map((item) => `"${item}"`).join(", ");
  return `notify = [${items}]`;
}

/** The notify line as written by pre-rename (hollr) versions — also ours. */
function legacyNotifyLine(): string {
  const items = NOTIFY_ARGV.map((item, index) => `"${index === 0 ? "hollr" : item}"`).join(", ");
  return `notify = [${items}]`;
}

/** Net `[`-vs-`]` count for a line, used to track array-value bracket depth. */
function bracketDelta(line: string): number {
  const opens = (line.match(/\[/g) ?? []).length;
  const closes = (line.match(/\]/g) ?? []).length;
  return opens - closes;
}

/**
 * Index of the last line of the `notify` assignment beginning at `start`.
 * A scalar (`notify = "x"`) or single-line array (`notify = [...]`) ends on
 * `start`; a multi-line array continues until bracket depth returns to zero.
 * An unterminated array consumes through the top-level region (`limit`).
 */
function notifyEndIndex(lines: string[], start: number, limit: number): number {
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    depth += bracketDelta(lines[index] ?? "");
    if (depth <= 0) {
      return index;
    }
  }
  return limit - 1;
}

/**
 * Replace the whole `notify` assignment spanning `[start, end]` with the single
 * `target` line, preserving everything before and after it.
 */
function replaceNotifyRange(
  lines: string[],
  start: number,
  end: number,
  target: string,
): string {
  const next = [...lines];
  next.splice(start, end - start + 1, target);
  return next.join(NEWLINE);
}

/** First table-header line index, or `lines.length` when there is none. */
function firstTableHeaderIndex(lines: string[]): number {
  const index = lines.findIndex((line) => TABLE_HEADER_PATTERN.test(line));
  return index === -1 ? lines.length : index;
}

/** Index of the top-level `notify` key (before any table header), or `-1`. */
function topLevelNotifyIndex(lines: string[], limit: number): number {
  for (let index = 0; index < limit; index += 1) {
    if (NOTIFY_KEY_PATTERN.test(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

/**
 * Insert the notify line as a top-level key: before the first table header if
 * one exists (top-level keys must precede tables), else appended at the end.
 */
function insertNotifyLine(
  original: string,
  lines: string[],
  target: string,
): string {
  const headerIndex = lines.findIndex((line) => TABLE_HEADER_PATTERN.test(line));
  if (headerIndex === -1) {
    const base = original.endsWith(NEWLINE) ? original : `${original}${NEWLINE}`;
    return `${base}${target}${NEWLINE}`;
  }
  const next = [...lines];
  next.splice(headerIndex, 0, target);
  return next.join(NEWLINE);
}

/**
 * Build the new config.toml text: patch ONLY the `notify` key (add/replace) and
 * preserve everything else. Idempotent — an already-correct file returns as-is.
 */
function patchNotify(original: string | null): string {
  const target = notifyLine();
  if (original === null || original.trim().length === 0) {
    return `${target}${NEWLINE}`;
  }
  const lines = original.split(NEWLINE);
  const limit = firstTableHeaderIndex(lines);
  const start = topLevelNotifyIndex(lines, limit);
  if (start !== -1) {
    return replaceNotifyRange(lines, start, notifyEndIndex(lines, start, limit), target);
  }
  return insertNotifyLine(original, lines, target);
}

/**
 * Surgically strip the top-level kelbrin `notify` assignment, leaving every
 * other key untouched. Absent notify ⇒ original returned as-is; absent file
 * ⇒ `null` (nothing to write).
 */
function removeNotify(original: string | null): string | null {
  if (original === null) {
    return null;
  }
  const lines = original.split(NEWLINE);
  const limit = firstTableHeaderIndex(lines);
  const start = topLevelNotifyIndex(lines, limit);
  if (start === -1) {
    return original;
  }
  const end = notifyEndIndex(lines, start, limit);
  const next = [...lines];
  next.splice(start, end - start + 1);
  return next.join(NEWLINE);
}

// --- pre-existing user notify: archive at wire time, restore at unwire -----

const NOTIFY_BACKUP_FILE = "codex-notify.bak";

/** Where a pre-existing user `notify` is archived across wire → unwire. */
function codexNotifyBackupPath(): string {
  return join(kelbrinHome(), NOTIFY_BACKUP_FILE);
}

/** Read the archived notify text, or `null` when there is none. Never throws. */
function readNotifyBackup(): string | null {
  return readFileOrNull(codexNotifyBackupPath());
}

/** Best-effort archive write; a failure here must not block wiring. */
function writeNotifyBackup(content: string): void {
  try {
    const path = codexNotifyBackupPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch {
    // Archiving is best-effort — losing it degrades to today's delete-on-unwire.
  }
}

/** Best-effort backup cleanup; a missing file is already the desired state. */
function deleteNotifyBackup(): void {
  try {
    rmSync(codexNotifyBackupPath(), { force: true });
  } catch {
    // Nothing to clean up, or unremovable — either way, not fatal.
  }
}

/**
 * The exact text of the top-level `notify` assignment (single- or multi-line),
 * or `null` when absent. Scoped to the pre-table region, like `patchNotify`.
 */
function extractNotify(original: string | null): string | null {
  if (original === null) {
    return null;
  }
  const lines = original.split(NEWLINE);
  const limit = firstTableHeaderIndex(lines);
  const start = topLevelNotifyIndex(lines, limit);
  if (start === -1) {
    return null;
  }
  const end = notifyEndIndex(lines, start, limit);
  return lines.slice(start, end + 1).join(NEWLINE);
}

/**
 * Archive the user's own pre-existing `notify` before kelbrin overwrites it, so
 * `unwire` can restore it later. A stale backup (no user notify, or the
 * existing notify is already kelbrin's own) is cleared instead.
 */
function archiveExistingNotify(original: string | null): void {
  const existing = extractNotify(original);
  if (existing !== null && existing !== notifyLine() && existing !== legacyNotifyLine()) {
    writeNotifyBackup(existing);
    return;
  }
  deleteNotifyBackup();
}

/** Splice the archived text into kelbrin's notify range within `current`. */
function restoreNotifyRange(current: string, backup: string): string {
  const lines = current.split(NEWLINE);
  const limit = firstTableHeaderIndex(lines);
  const start = topLevelNotifyIndex(lines, limit);
  if (start === -1) {
    return current;
  }
  const end = notifyEndIndex(lines, start, limit);
  return replaceNotifyRange(lines, start, end, backup);
}

/**
 * Unwire transform: restore the user's archived `notify` in place of kelbrin's
 * when a backup exists (consuming and deleting it), else fall back to the
 * plain delete (`removeNotify`) — preserving today's no-backup behavior.
 */
function restoreOrRemoveNotify(current: string | null): string | null {
  const backup = readNotifyBackup();
  if (backup === null) {
    return removeNotify(current);
  }
  const restored = current === null ? null : restoreNotifyRange(current, backup);
  deleteNotifyBackup();
  return restored;
}

// --- hooks.json PermissionRequest patch (Claude-style JSON) -----------------

/**
 * kelbrin's own blocked-hook command forms — current plus the pre-rename
 * (hollr) one old installs wrote; both count as ours for strip/unwire.
 */
const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  BLOCKED_COMMAND,
  legacyCommandVariant(BLOCKED_COMMAND),
]);

/** True when a PermissionRequest entry already carries kelbrin's command. */
function entryHasCommand(entry: unknown): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some(
    (hook) =>
      isRecord(hook) &&
      typeof hook.command === "string" &&
      BLOCKED_COMMANDS.has(hook.command),
  );
}

/** Append kelbrin's PermissionRequest entry unless it is already present. */
function appendPermissionEntry(existing: unknown): unknown[] {
  const list = Array.isArray(existing) ? existing : [];
  if (list.some(entryHasCommand)) {
    return list;
  }
  return [
    ...list,
    {
      matcher: HOOK_MATCHER,
      hooks: [{ type: HOOK_TYPE_COMMAND, command: BLOCKED_COMMAND }],
    },
  ];
}

/**
 * Idempotent mutation adding kelbrin's PermissionRequest hook while preserving
 * every unrelated hook event and any pre-existing PermissionRequest entries.
 */
function addPermissionHook(json: JsonObject): JsonObject {
  const hooks = isRecord(json.hooks) ? json.hooks : {};
  return {
    ...json,
    hooks: {
      ...hooks,
      [HOOK_EVENT]: appendPermissionEntry(hooks[HOOK_EVENT]),
    },
  };
}

/** Surgically remove only kelbrin's PermissionRequest entry, keeping the rest. */
function removeHooks(json: JsonObject): JsonObject {
  return removeKelbrinHooks(json, [HOOK_EVENT], entryHasCommand);
}

/** Concatenate the non-empty per-file diffs. */
function joinDiffs(configDiff: string, hooksDiff: string): string {
  return [configDiff, hooksDiff].filter((diff) => diff.length > 0).join(NEWLINE);
}

// --- adapter ----------------------------------------------------------------

export const codex: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "OpenAI Codex — notify done/read-aloud and PermissionRequest blocked",
  capabilities: {
    done: true,
    blocked: true,
    readAloud: true,
    slashCommand: false,
    instructionInjection: true,
  },

  memoryPath(deps: AdapterDeps): string {
    return join(deps.home, CONFIG_DIR, "AGENTS.md");
  },

  detect(deps: AdapterDeps): Promise<Detection> {
    const installed =
      deps.which(BINARY) !== null || isDir(join(deps.home, CONFIG_DIR));
    const detection: Detection = { installed };
    if (installed) {
      detection.configPath = configPath(deps);
    }
    return Promise.resolve(detection);
  },

  wire(deps: AdapterDeps): Promise<WireResult> {
    const cfgPath = configPath(deps);
    const originalConfig = readFileOrNull(cfgPath);
    archiveExistingNotify(originalConfig);
    const configOp = wireTextFile(cfgPath, patchNotify(originalConfig), CONFIG_LEDGER_KEY);
    const hooksOp = wireJsonFile(
      hooksPath(deps),
      (json) => addPermissionHook(removeHooks(json)),
      HOOKS_LEDGER_KEY,
    );
    const result: WireResult = {
      changed: configOp.changed || hooksOp.changed,
      diff: joinDiffs(configOp.diff, hooksOp.diff),
      warnings: [HOOK_TRUST_WARNING],
    };
    configOp.apply();
    hooksOp.apply();
    return Promise.resolve(result);
  },

  unwire(deps: AdapterDeps): Promise<void> {
    unwireTextFile(configPath(deps), restoreOrRemoveNotify, CONFIG_LEDGER_KEY);
    unwireJsonFile(hooksPath(deps), removeHooks, HOOKS_LEDGER_KEY);
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
      summary: "",
      lastResponse: null,
    };
  },

  readLastResponse(raw: unknown): Promise<string | null> {
    if (!isRecord(raw)) {
      return Promise.resolve(null);
    }
    const message = raw[LAST_MESSAGE_FIELD];
    return Promise.resolve(typeof message === "string" ? message : null);
  },
};
