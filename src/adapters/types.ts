/**
 * The adapter contract. An adapter is the only kelbrin component that knows a
 * specific agent's shape: it {@link Adapter.normalize | normalizes} that agent's
 * hook payload into a {@link KelbrinEvent}, and {@link Adapter.wire | wires} the
 * agent's own config so it calls `kelbrin emit`. Adapters never talk to sinks —
 * they feed the core router, which owns the platform engines and webhook sink.
 */

import type { EventName } from "../core/config.ts";
import type { KelbrinEvent } from "../core/events.ts";

/**
 * Dependencies handed to filesystem/PATH-touching adapter methods so they are
 * testable without mutating the developer's real home: tests inject a temp
 * `home` and a fake `which` instead of `~` and the real PATH lookup.
 */
export interface AdapterDeps {
  /** User home dir; tests inject a temp dir instead of the real `~`. */
  home: string;
  /** PATH lookup used by {@link Adapter.detect}; returns the path or `null`. */
  which(bin: string): string | null;
}

/** Result of probing whether an agent is installed and kelbrin-compatible. */
export interface Detection {
  installed: boolean;
  version?: string;
  configPath?: string;
  /** Set when installed but with reduced capability, explaining the limitation. */
  degraded?: string;
}

/** Outcome of a (dry or applied) wire: whether it changed anything, plus a diff. */
export interface WireResult {
  changed: boolean;
  diff: string;
  warnings: string[];
}

/** What an adapter can drive on its agent, for setup UIs and doctor output. */
export interface AdapterCapabilities {
  done: boolean;
  blocked: boolean;
  readAloud: boolean;
  slashCommand: boolean;
  /** Whether kelbrin can inject a read-aloud instruction into the agent's global memory file. */
  instructionInjection: boolean;
}

/**
 * A single agent integration. Structurally a superset of the doctor's
 * `DetectableAgent`, so the registry can be passed straight to `checkAll`.
 */
export interface Adapter {
  id: string;
  title: string;
  tagline: string;
  capabilities: AdapterCapabilities;
  detect(deps: AdapterDeps): Promise<Detection>;
  /** Idempotent; callers show the diff before applying. */
  wire(deps: AdapterDeps): Promise<WireResult>;
  unwire(deps: AdapterDeps): Promise<void>;
  /** Turn a raw hook payload into an event, or `null` to decline (not our event). */
  normalize(raw: unknown, eventHint: EventName): KelbrinEvent | null;
  /** Read the agent's last assistant response (e.g. from a transcript in `raw`). */
  readLastResponse(raw: unknown): Promise<string | null>;
  /**
   * Absolute path to the agent's GLOBAL standing-instructions file (e.g.
   * `~/.claude/CLAUDE.md`). Present only when `capabilities.instructionInjection`
   * is true; kelbrin injects the read-aloud block here.
   */
  memoryPath?(deps: AdapterDeps): string;
}
