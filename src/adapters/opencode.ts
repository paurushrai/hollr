/**
 * The opencode adapter — wires sst's `opencode` CLI to hollr.
 *
 * VERIFIED integration (sst/opencode, docs + source read 2026-07-11):
 *   1. Unlike hollr's other adapters, opencode integrates through a JS PLUGIN
 *      file, not a hooks-config mutation. opencode scans `{plugin,plugins}/*.{ts,js}`
 *      under each config root and auto-loads every match at startup
 *      (packages/opencode/src/config/plugin.ts), so dropping this file at
 *      `~/.config/opencode/plugin/hollr.js` is enough — no config edit needed.
 *   2. A plugin is an async function receiving a context (`{ $, directory, ... }`)
 *      and returning a hooks object. Lifecycle events arrive through a single
 *      `event` hook as `{ event }` where `event.type` discriminates. The verified
 *      types (opencode.ai/docs/plugins) are `session.idle` (turn finished → done)
 *      and `permission.asked` (agent needs approval → blocked).
 *   3. The runtime is Bun; the context's `$` is Bun's shell, so the plugin shells
 *      out to `hollr emit --agent opencode --event <e> --payload-argv <json>`.
 *      `$` escapes the interpolated JSON as a single argv, which `emit` consumes.
 *      `.quiet().nothrow()` plus a try/catch keep a notification failure from ever
 *      disrupting the coding session.
 *
 * Read-aloud is intentionally OFF: opencode's on-disk transcript is a message +
 * part split under `~/.local/share/opencode/storage/` whose exact shape is
 * internal/undocumented and churns (session pruning, unbounded growth). Rather
 * than ship a fragile multi-file parser, hollr degrades to an announce-only
 * `done` — {@link readLastResponse} always yields `null` and never throws.
 *
 * `normalize`/`readLastResponse`/`detect` run inside (or adjacent to) the plugin
 * and MUST NOT throw. `wire`/`unwire` go through {@link wireTextFile}/
 * {@link unwireFromLedger} so the created file is previewable and byte-reversible.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireFromLedger, wireTextFile } from "./diffwire.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "opencode";
const TITLE = "opencode";
const BINARY = "opencode";
const LEDGER_KEY = "opencode";
const CONFIG_SEGMENTS = [".config", "opencode"] as const;
const PLUGIN_DIR = "plugin";
const PLUGIN_FILE = "hollr.js";

/** Verified `event.type` values the plugin subscribes to. */
const EVENT_SESSION_IDLE = "session.idle";
const EVENT_PERMISSION_ASKED = "permission.asked";
/** hollr event names emitted for each subscription. */
const EMIT_DONE: EventName = "done";
const EMIT_BLOCKED: EventName = "blocked";

/** The `hollr emit` invocation prefix the plugin shells out to. */
const EMIT_COMMAND_PREFIX = `hollr emit --agent ${ID}`;

/**
 * The plugin file hollr writes. It is DATA (a JS source string), not a module:
 * runtime `${...}` interpolations are escaped (`\${...}`) so only the adapter's
 * own constants are substituted here. Managed by hollr and fully reversible.
 */
const PLUGIN_TEMPLATE = `// Managed by hollr — reversible via \`hollr uninstall\`. Do not edit by hand.
// Bridges opencode lifecycle events to the hollr CLI (voice + desktop notifications).
// opencode auto-loads .js/.ts files under ~/.config/opencode/plugin/ (and .opencode/plugin/).
export const hollr = async ({ $, directory }) => {
  const emit = async (event, properties) => {
    const payload = JSON.stringify({
      cwd: directory,
      sessionID: properties?.sessionID ?? null,
    });
    try {
      await $\`${EMIT_COMMAND_PREFIX} --event \${event} --payload-argv \${payload}\`
        .quiet()
        .nothrow();
    } catch {
      // A notification failure must never disrupt the coding session.
    }
  };
  return {
    event: async ({ event }) => {
      if (event.type === "${EVENT_SESSION_IDLE}") {
        await emit("${EMIT_DONE}", event.properties);
        return;
      }
      if (event.type === "${EVENT_PERMISSION_ASKED}") {
        await emit("${EMIT_BLOCKED}", event.properties);
      }
    },
  };
};
`;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configDir(deps: AdapterDeps): string {
  return join(deps.home, ...CONFIG_SEGMENTS);
}

function pluginPath(deps: AdapterDeps): string {
  return join(configDir(deps), PLUGIN_DIR, PLUGIN_FILE);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- adapter ----------------------------------------------------------------

export const opencode: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "sst opencode — plugin bridges session.idle done and permission.asked blocked",
  capabilities: {
    done: true,
    blocked: true,
    readAloud: false,
    slashCommand: false,
    instructionInjection: false,
  },

  detect(deps: AdapterDeps): Promise<Detection> {
    const installed =
      deps.which(BINARY) !== null || isDir(configDir(deps));
    const detection: Detection = { installed };
    if (installed) {
      detection.configPath = pluginPath(deps);
    }
    return Promise.resolve(detection);
  },

  wire(deps: AdapterDeps): Promise<WireResult> {
    const op = wireTextFile(pluginPath(deps), PLUGIN_TEMPLATE, LEDGER_KEY);
    const result: WireResult = {
      changed: op.changed,
      diff: op.diff,
      warnings: [],
    };
    op.apply();
    return Promise.resolve(result);
  },

  unwire(_deps: AdapterDeps): Promise<void> {
    unwireFromLedger(LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): HollrEvent | null {
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

  readLastResponse(_raw: unknown): Promise<string | null> {
    return Promise.resolve(null);
  },
};
