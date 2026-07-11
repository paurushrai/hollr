/**
 * The adapter registry: the single list of known agent integrations. Doctor
 * probes every entry (detection) and emit routes normalization through
 * {@link byId}. claude-code is the reference adapter; the list grows one entry
 * per adapter task.
 */

import { antigravity } from "./antigravity.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import type { Adapter } from "./types.ts";

/** Every known adapter, in display order. Grows one entry per adapter task. */
export const adapters: Adapter[] = [claudeCode, antigravity, codex, copilot];

/** Look up an adapter by its stable id, or `undefined` when unknown. */
export function byId(id: string): Adapter | undefined {
  return adapters.find((adapter) => adapter.id === id);
}
