/**
 * The adapter registry: the single list of known agent integrations. Doctor
 * probes every entry (detection) and emit routes normalization through
 * {@link byId}. It is intentionally empty until concrete adapters land
 * (T10 adds claude-code); the plumbing that consumes it is already live.
 */

import type { Adapter } from "./types.ts";

/** Every known adapter, in display order. Grows one entry per adapter task. */
export const adapters: Adapter[] = [];

/** Look up an adapter by its stable id, or `undefined` when unknown. */
export function byId(id: string): Adapter | undefined {
  return adapters.find((adapter) => adapter.id === id);
}
