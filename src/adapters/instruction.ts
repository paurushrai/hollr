/**
 * Read-aloud "speakable mode" instruction — the block kelbrin injects into an
 * agent's global memory file so the model keeps its final message speakable and
 * routes code/detail to a temp file it opens for the user. Shared by every
 * instruction-capable adapter; the only per-user variable is the markdown-open
 * command. Injection is reversible via the diffwire marked-section ledger.
 */

import { join } from "node:path";

import { kelbrinHome } from "../core/config.ts";
import type { WireOp } from "./diffwire.ts";
import { wireMarkedSection } from "./diffwire.ts";

/** Marker id shared by every adapter's read-aloud block. */
export const READALOUD_MARKER = "kelbrin:readaloud";

/** Marker id written by pre-rename (hollr) versions; replaced on re-wire. */
const LEGACY_READALOUD_MARKER = "hollr:readaloud";

/** Directory the model is told to write temp read-aloud files into. */
export function readaloudTempDir(): string {
  return join(kelbrinHome(), "readaloud");
}

/** Ledger key for an adapter's read-aloud injection: `<id>:readaloud`. */
export function readaloudLedgerKey(adapterId: string): string {
  return `${adapterId}:readaloud`;
}

/**
 * The instruction body (marker wrapping is added by the diffwire writer). Plain
 * text so it lands cleanly in CLAUDE.md / AGENTS.md / GEMINI.md alike.
 */
export function buildReadaloudBlock(openCommand: string): string {
  const dir = readaloudTempDir();
  return [
    "Your responses are being read aloud (text-to-speech). For the FINAL message each turn:",
    "- Write plain, speakable sentences. No headers, tables, bullet lists, or inline backticks in the spoken part.",
    `- When the answer needs code, long output, or dense technical detail, DON'T speak it: write it to a temp .md file under ${dir} and open it with \`${openCommand} <file>\`, then say one sentence pointing the user there.`,
    "- Keep file-dumps INTENTIONAL and rare — only when detail truly won't read aloud well. Never create files for short or conversational answers.",
    "This shapes only how you present the final message; it does not change the work you do.",
  ].join("\n");
}

/** Prepare the reversible injection of the read-aloud block into `memoryPath`. */
export function injectReadaloud(
  memoryPath: string,
  openCommand: string,
  adapterId: string,
): WireOp {
  return wireMarkedSection(
    memoryPath,
    READALOUD_MARKER,
    buildReadaloudBlock(openCommand),
    readaloudLedgerKey(adapterId),
    [LEGACY_READALOUD_MARKER],
  );
}
