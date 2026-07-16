/**
 * Normalized kelbrin event and the pure text helpers the router needs. An event
 * is the agent-agnostic shape that adapters produce; the router consumes it.
 */

import { basename } from "node:path";

import type { EventName } from "./config.ts";

/**
 * A single agent-turn signal, already normalized by an adapter. `project` is
 * the speakable label (see {@link projectLabel}); `lastResponse` is the raw
 * assistant text used by readaloud, absent when the adapter cannot supply it.
 */
export interface KelbrinEvent {
  v: 1;
  ts: string;
  agent: string;
  agentTitle: string;
  event: EventName;
  cwd: string;
  project: string;
  summary: string;
  lastResponse?: string | null;
}

const TRAILING_SEPARATORS = /[/\\]+$/;
const WORD_SEPARATORS = /[-_]/g;
const CODE_BLOCK = /```[\s\S]*?```/g;
const BACKTICK = /`/g;
const WHITESPACE_RUN = /\s+/g;
const CODE_BLOCK_PLACEHOLDER = " code block omitted. ";

/** Basename of `cwd` with `-` and `_` turned into spaces, for speaking. */
export function projectLabel(cwd: string): string {
  const trimmed = cwd.replace(TRAILING_SEPARATORS, "");
  const base = basename(trimmed) || cwd;
  return base.replace(WORD_SEPARATORS, " ");
}

/**
 * Make raw markdown speakable (ports v1 `transcript.prepare_speech_text`):
 * when `stripCode`, fenced blocks become a spoken placeholder and stray
 * backticks are removed; then whitespace runs collapse and the result is
 * trimmed and capped to `maxChars`.
 */
export function prepareSpeechText(
  text: string,
  maxChars: number,
  stripCode: boolean,
): string {
  let out = text;
  if (stripCode) {
    out = out.replace(CODE_BLOCK, CODE_BLOCK_PLACEHOLDER).replace(BACKTICK, "");
  }
  return out.replace(WHITESPACE_RUN, " ").trim().slice(0, maxChars);
}
