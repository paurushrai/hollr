/**
 * Diff-transparent file wiring with a reversal ledger. Adapters mutate an
 * agent's own config through these two writers so every change is (a) previewed
 * as a diff before it lands and (b) fully reversible: each `apply()` writes the
 * file atomically and records the pre-existing content in `<HOLLR_HOME>/wired.json`,
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

import { hollrHome } from "../core/config.ts";

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
}

const JSON_INDENT = 2;
const TRAILING_NEWLINE = "\n";
const LEDGER_FILE = "wired.json";
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

/** Canonical serialization used for every JSON file hollr writes. */
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

/** Write `content` to `path` atomically (temp file then rename). */
function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

function ledgerPath(): string {
  return join(hollrHome(), LEDGER_FILE);
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.ledgerKey === "string" &&
    typeof value.path === "string" &&
    (value.before === null || typeof value.before === "string") &&
    typeof value.at === "string"
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

function writeLedger(entries: LedgerEntry[]): void {
  mkdirSync(hollrHome(), { recursive: true });
  writeFileAtomic(
    ledgerPath(),
    `${JSON.stringify(entries, null, JSON_INDENT)}${TRAILING_NEWLINE}`,
  );
}

function appendLedgerEntry(entry: LedgerEntry): void {
  const entries = readLedger();
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

function restoreEntry(entry: LedgerEntry): void {
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
