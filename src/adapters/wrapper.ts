/**
 * The `wrapper` pseudo-adapter — the universal fallback for agents whose native
 * hooks cannot drive read-aloud or blocked events (e.g. Cursor, Amp). It has no
 * config to wire: the user opts in per invocation by prefixing their command
 * with `kelbrin run -- <cmd>`, so {@link Adapter.wire} is a no-op that only prints
 * usage, and {@link Adapter.detect} always reports installed (it ships with the
 * CLI itself). Events are built by the `kelbrin run` command, not by
 * {@link Adapter.normalize}, so normalize/readLastResponse always decline.
 */

import type { EventName } from "../core/config.ts";
import type { KelbrinEvent } from "../core/events.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "wrapper";
const TITLE = "Wrapper";
const USAGE_HINT =
  "wrap any agent with `kelbrin run -- <cmd> [args...]`; " +
  "add `--announce-stream cursor` before `--` for read-aloud of cursor output";

export const wrapper: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "Universal wrapper — announce any agent via `kelbrin run -- <cmd>`",
  capabilities: {
    done: true,
    blocked: false,
    readAloud: true,
    slashCommand: false,
    instructionInjection: false,
  },

  detect(_deps: AdapterDeps): Promise<Detection> {
    return Promise.resolve({ installed: true });
  },

  wire(_deps: AdapterDeps): Promise<WireResult> {
    return Promise.resolve({ changed: false, diff: "", warnings: [USAGE_HINT] });
  },

  unwire(_deps: AdapterDeps): Promise<void> {
    return Promise.resolve();
  },

  normalize(_raw: unknown, _eventHint: EventName): KelbrinEvent | null {
    return null;
  },

  readLastResponse(_raw: unknown): Promise<string | null> {
    return Promise.resolve(null);
  },
};
