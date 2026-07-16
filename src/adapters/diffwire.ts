/**
 * Diff-transparent file wiring with a reversal ledger. Adapters mutate an
 * agent's own config through these two writers so every change is (a) previewed
 * as a diff before it lands and (b) fully reversible: each `apply()` writes the
 * file atomically and records the pre-existing content in `<KELBRIN_HOME>/wired.json`,
 * so {@link unwireFromLedger} can restore it byte-for-byte — or delete a file
 * that did not exist before.
 *
 * Every read degrades to empty (`{}`/`""`) and never throws: this code runs
 * from setup and never inside a hook, but the same defensive posture keeps a
 * malformed config from aborting a wire.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { kelbrinHome } from "../core/config.ts";

/** A prepared, previewable write. Nothing touches disk until `apply()`. */
export interface WireOp {
  /** Line diff of the pending change; empty when nothing changes. */
  diff: string;
  /** True when applying would alter the file. */
  changed: boolean;
  /** Write the file atomically and append a reversal entry to the ledger. */
  apply(): void;
}

/** A JSON object; the shape adapters mutate for JSON configs. */
type JsonObject = Record<string, unknown>;

/** One reversible change, as persisted to the ledger. */
interface LedgerEntry {
  ledgerKey: string;
  path: string;
  /** Original file content, or `null` when the file did not exist. */
  before: string | null;
  at: string;
  /** Reversal strategy. Absent ⇒ "file" (whole-file restore), the legacy shape. */
  kind?: "file" | "marked";
  /** For "marked" entries: the marker id whose block unwire strips. */
  markerId?: string;
}

const JSON_INDENT = 2;
const TRAILING_NEWLINE = "\n";
const LEDGER_FILE = "wired.json";
/**
 * The ledger stores each foreign config file's prior content verbatim so a wire
 * is byte-reversible — and those files (e.g. `~/.claude/settings.json`) often
 * hold tokens/credentials. Restrict it to the owner, like the global config.
 */
const LEDGER_MODE = 0o600;
const DIFF_CONTEXT_LINES = 3;
const REMOVED_MARK = "-";
const ADDED_MARK = "+";
const CONTEXT_MARK = " ";

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSON object defensively; any failure or non-object yields `{}`. */
function parseJsonObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Canonical serialization used for every JSON file kelbrin writes. */
function serializeJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, JSON_INDENT)}${TRAILING_NEWLINE}`;
}

/** Read a file's contents, or `null` when it is absent/unreadable. */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write `content` to `path` atomically (temp file then rename). When `mode` is
 * given, the temp file is created with it and the rename preserves it, so the
 * final file lands with those permissions even if it already existed.
 */
function writeFileAtomic(path: string, content: string, mode?: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(temp, path);
}

function ledgerPath(): string {
  return join(kelbrinHome(), LEDGER_FILE);
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isPlainObject(value)) {
    return false;
  }
  const kindOk =
    value.kind === undefined || value.kind === "file" || value.kind === "marked";
  const markerOk = value.markerId === undefined || typeof value.markerId === "string";
  return (
    typeof value.ledgerKey === "string" &&
    typeof value.path === "string" &&
    (value.before === null || typeof value.before === "string") &&
    typeof value.at === "string" &&
    kindOk &&
    markerOk
  );
}

/** Read the ledger, dropping any malformed entries; missing file yields `[]`. */
function readLedger(): LedgerEntry[] {
  const raw = readFileOrNull(ledgerPath());
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLedgerEntry) : [];
  } catch {
    return [];
  }
}

/**
 * The ledger keys of every currently-wired change, for read-only callers like
 * `kelbrin status`. Defensive: a missing or malformed ledger yields `[]`.
 */
export function listWiredKeys(): string[] {
  return readLedger().map((entry) => entry.ledgerKey);
}

function writeLedger(entries: LedgerEntry[]): void {
  mkdirSync(kelbrinHome(), { recursive: true });
  writeFileAtomic(
    ledgerPath(),
    `${JSON.stringify(entries, null, JSON_INDENT)}${TRAILING_NEWLINE}`,
    LEDGER_MODE,
  );
}

/**
 * Record one reversal entry, keyed by `ledgerKey`. If an entry for the key
 * already exists at the SAME path/marker it is kept as-is: the earliest capture
 * holds the true pre-kelbrin `before`, so preserving it keeps unwire
 * byte-accurate and stops a re-wire from appending a duplicate key (which
 * `status` would list twice). If the key's artifact moved — the hollr→kelbrin
 * rename moved managed files (`hollr.md` → `kelbrin.md`) and marker ids — the
 * stale artifact is reversed on the spot so it does not linger, and the entry
 * is replaced to track the new one.
 */
function appendLedgerEntry(entry: LedgerEntry): void {
  const entries = readLedger();
  const existing = entries.find((item) => item.ledgerKey === entry.ledgerKey);
  if (existing !== undefined) {
    if (existing.path === entry.path && existing.markerId === entry.markerId) {
      return;
    }
    restoreEntry(existing);
    writeLedger([
      ...entries.filter((item) => item.ledgerKey !== entry.ledgerKey),
      entry,
    ]);
    return;
  }
  entries.push(entry);
  writeLedger(entries);
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function commonPrefixLength(a: string[], b: string[]): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string[], b: string[], prefix: number): number {
  let count = 0;
  while (
    count < a.length - prefix &&
    count < b.length - prefix &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

/**
 * Render a line diff of `oldText` vs `newText`: the changed hunk with removed
 * (`-`) and added (`+`) lines, framed by up to {@link DIFF_CONTEXT_LINES} of
 * unchanged context (` `). Returns `""` when the texts are identical.
 */
function renderLineDiff(oldText: string, newText: string): string {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return "";
  }
  const leading = before.slice(Math.max(0, prefix - DIFF_CONTEXT_LINES), prefix);
  const tailStart = before.length - suffix;
  const trailing = before.slice(tailStart, tailStart + DIFF_CONTEXT_LINES);
  return [
    ...leading.map((line) => `${CONTEXT_MARK}${line}`),
    ...removed.map((line) => `${REMOVED_MARK}${line}`),
    ...added.map((line) => `${ADDED_MARK}${line}`),
    ...trailing.map((line) => `${CONTEXT_MARK}${line}`),
  ].join("\n");
}

/** Build a {@link WireOp} from the original content and the intended content. */
function buildWireOp(
  path: string,
  original: string | null,
  nextContent: string,
  ledgerKey: string,
): WireOp {
  const oldContent = original ?? "";
  const changed = oldContent !== nextContent;
  return {
    diff: renderLineDiff(oldContent, nextContent),
    changed,
    apply(): void {
      if (!changed) {
        return;
      }
      writeFileAtomic(path, nextContent);
      appendLedgerEntry({
        ledgerKey,
        path,
        before: original,
        at: new Date().toISOString(),
      });
    },
  };
}

/**
 * Prepare a change to a JSON config: read-or-`{}`, run `mutate` to produce the
 * new object, and diff the canonical serialization against the current file.
 * `mutate` must be idempotent so re-wiring an already-wired file is a no-op.
 */
export function wireJsonFile(
  path: string,
  mutate: (json: JsonObject) => JsonObject,
  ledgerKey: string,
): WireOp {
  const original = readFileOrNull(path);
  const nextContent = serializeJson(mutate(parseJsonObject(original ?? "")));
  return buildWireOp(path, original, nextContent, ledgerKey);
}

/**
 * Prepare a whole-file write of `newContent` (for non-JSON configs). The ledger
 * stores the entire prior file, so unwiring restores it exactly.
 */
export function wireTextFile(
  path: string,
  newContent: string,
  ledgerKey: string,
): WireOp {
  return buildWireOp(path, readFileOrNull(path), newContent, ledgerKey);
}

function startMarker(markerId: string): string {
  return `<!-- ${markerId}:start (managed by kelbrin — \`kelbrin uninstall\`, or re-run \`kelbrin init\` with read-aloud off, removes this) -->`;
}

function endMarker(markerId: string): string {
  return `<!-- ${markerId}:end -->`;
}

/** The full fenced block for `markerId` wrapping `body`. */
function markedBlock(markerId: string, body: string): string {
  return `${startMarker(markerId)}\n${body}\n${endMarker(markerId)}`;
}

/**
 * Remove the `markerId` block (start line … end line inclusive) from `content`,
 * collapsing the blank line that preceded it. Returns `content` unchanged when
 * the markers are not both present.
 */
/**
 * Prefix identifying a block's start line regardless of the management wording
 * after it — that wording changed across the hollr→kelbrin rename, so matching
 * the full {@link startMarker} string would miss blocks written by old versions.
 */
function startMarkerPrefix(markerId: string): string {
  return `<!-- ${markerId}:start`;
}

function stripMarkedSection(content: string, markerId: string): string {
  const start = content.indexOf(startMarkerPrefix(markerId));
  if (start === -1) {
    return content;
  }
  const endToken = endMarker(markerId);
  const endIdx = content.indexOf(endToken, start);
  if (endIdx === -1) {
    return content;
  }
  const after = endIdx + endToken.length;
  // Drop one leading newline (the blank line separating the block) if present.
  const head = content.slice(0, start).replace(/\n?\n$/, "\n");
  const tail = content.slice(after).replace(/^\n/, "");
  return `${head}${tail}`;
}

/**
 * Insert or replace the `markerId` block in `content`. Existing block → replace
 * in place; absent → append after a blank line, ensuring a trailing newline.
 */
function upsertMarkedSection(content: string, markerId: string, body: string): string {
  const block = markedBlock(markerId, body);
  const start = content.indexOf(startMarkerPrefix(markerId));
  if (start !== -1) {
    const stripped = stripMarkedSection(content, markerId);
    const base = stripped.length === 0 || stripped.endsWith("\n") ? stripped : `${stripped}\n`;
    return `${base}${base.length === 0 ? "" : "\n"}${block}\n`;
  }
  if (content.length === 0) {
    return `${block}\n`;
  }
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${block}\n`;
}

/**
 * Prepare an insert/update of a marker-fenced block in a (possibly existing)
 * plaintext instructions file. Reversal is SURGICAL: {@link unwireFromLedger}
 * strips only the block from the file's CURRENT content, so edits the user makes
 * after injection survive — unlike whole-file restore, which would clobber them.
 */
export function wireMarkedSection(
  path: string,
  markerId: string,
  blockBody: string,
  ledgerKey: string,
  legacyMarkerIds: readonly string[] = [],
): WireOp {
  const original = readFileOrNull(path);
  const base = legacyMarkerIds.reduce(
    (text, legacyId) => stripMarkedSection(text, legacyId),
    original ?? "",
  );
  const nextContent = upsertMarkedSection(base, markerId, blockBody);
  const oldContent = original ?? "";
  const changed = oldContent !== nextContent;
  return {
    diff: renderLineDiff(oldContent, nextContent),
    changed,
    apply(): void {
      if (!changed) {
        return;
      }
      writeFileAtomic(path, nextContent);
      appendLedgerEntry({
        ledgerKey,
        path,
        before: original,
        at: new Date().toISOString(),
        kind: "marked",
        markerId,
      });
    },
  };
}

function restoreEntry(entry: LedgerEntry): void {
  if (entry.kind === "marked" && typeof entry.markerId === "string") {
    const current = readFileOrNull(entry.path);
    if (current === null) {
      return; // file gone → nothing to strip
    }
    const stripped = stripMarkedSection(current, entry.markerId);
    if (stripped !== current) {
      writeFileAtomic(entry.path, stripped);
    }
    return;
  }
  if (entry.before === null) {
    try {
      rmSync(entry.path, { force: true });
    } catch {
      // Nothing to restore to; a missing file is already the desired state.
    }
    return;
  }
  writeFileAtomic(entry.path, entry.before);
}

/**
 * Reverse the change recorded under `ledgerKey`: restore the original file
 * byte-for-byte (or delete it if it did not exist before), then drop the entry.
 * Unknown keys are a no-op.
 */
export function unwireFromLedger(ledgerKey: string): void {
  const entries = readLedger();
  const entry = entries.find((item) => item.ledgerKey === ledgerKey);
  if (entry === undefined) {
    return;
  }
  restoreEntry(entry);
  writeLedger(entries.filter((item) => item.ledgerKey !== ledgerKey));
}

/** Remove the entry for `ledgerKey` from the ledger (no-op if absent). */
function dropLedgerKey(ledgerKey: string): void {
  const entries = readLedger();
  const kept = entries.filter((entry) => entry.ledgerKey !== ledgerKey);
  if (kept.length !== entries.length) {
    writeLedger(kept);
  }
}

/**
 * Surgically reverse a JSON wiring: apply `removeMutate` to the file's CURRENT
 * content (not the ledger `before`), write only if it changed, and drop the
 * ledger key. A missing/malformed file is a no-op. This never restores a whole
 * file, so edits made after wiring survive.
 */
export function unwireJsonFile(
  path: string,
  removeMutate: (json: JsonObject) => JsonObject,
  ledgerKey: string,
): void {
  const original = readFileOrNull(path);
  if (original !== null) {
    const next = serializeJson(removeMutate(parseJsonObject(original)));
    if (next !== original) {
      writeFileAtomic(path, next);
    }
  }
  dropLedgerKey(ledgerKey);
}

/** Delete a file kelbrin created whole, and drop its ledger key. Never throws. */
export function unwireCreatedFile(path: string, ledgerKey: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Already gone or unremovable — the desired end state (absent) still holds.
  }
  dropLedgerKey(ledgerKey);
}

/**
 * Surgically reverse a plaintext wiring: run `transform` against the file's
 * CURRENT content (`null` when absent), write only when it returns a non-null
 * result that differs from the current content, and drop the ledger key.
 * Never throws.
 */
export function unwireTextFile(
  path: string,
  transform: (current: string | null) => string | null,
  ledgerKey: string,
): void {
  const original = readFileOrNull(path);
  const next = transform(original);
  if (next !== null && next !== original) {
    writeFileAtomic(path, next);
  }
  dropLedgerKey(ledgerKey);
}
