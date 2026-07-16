/**
 * The amp adapter — Sourcegraph Amp (`amp`). Announce-only, and deliberately the
 * thinnest adapter in the registry.
 *
 * VERIFIED against Amp's docs (ampcode.com, Jul 2026):
 *   - There is NO declarative `amp.hooks` array in `~/.config/amp/settings.json`.
 *     Amp's lifecycle hooks (`agent.end`, `tool.call`, …) are authored ONLY as
 *     TypeScript/JavaScript plugins (`.amp/plugins/*.ts`, `amp.on(event, fn)`),
 *     not as a JSON catalog kelbrin can safely write. kelbrin therefore does not
 *     fabricate a config file — {@link amp.wire} is instructions-only.
 *   - `amp.notifications.enabled` is Amp's own built-in turn-completion toggle;
 *     kelbrin leaves it to the user (it is context, not something kelbrin sets).
 *   - Threads/transcripts are stored on Sourcegraph's servers (cloud-only, synced
 *     across devices) with no reliable local file, so read-aloud is impossible:
 *     {@link amp.readLastResponse} always yields `null` and `readAloud` is false.
 *
 * `normalize`/`readLastResponse`/`detect` MUST NOT throw: every read degrades
 * defensively.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import type { EventName } from "../core/config.ts";
import type { KelbrinEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { unwireFromLedger } from "./diffwire.ts";
import type { Adapter, AdapterDeps, Detection, WireResult } from "./types.ts";

const ID = "amp";
const TITLE = "Amp";
const LEDGER_KEY = "amp";
const BINARY = "amp";

/** Amp's user settings dir, relative to `home`: `~/.config/amp`. */
const CONFIG_SEGMENTS = [".config", "amp"] as const;

/**
 * Guidance returned from {@link amp.wire}. Amp exposes no declarative hook
 * catalog, so kelbrin cannot auto-wire it; instead it points the user at Amp's
 * built-in notifications and the kelbrin `run` wrapper for announcements.
 */
const FALLBACK_WARNINGS: readonly string[] = [
  "Amp has no declarative hook catalog kelbrin can write, so nothing was changed.",
  'Enable Amp\'s built-in turn alert: set "amp.notifications.enabled": true in ~/.config/amp/settings.json.',
  "For kelbrin voice announcements, launch Amp through the wrapper: `kelbrin run --agent amp -- amp`.",
];

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configDir(deps: AdapterDeps): string {
  return join(deps.home, ...CONFIG_SEGMENTS);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Non-empty `cwd` string from the payload, else `""` (adapter never invents cwd). */
function payloadCwd(raw: JsonObject): string {
  return typeof raw.cwd === "string" ? raw.cwd : "";
}

export const amp: Adapter = {
  id: ID,
  title: TITLE,
  tagline: "Sourcegraph Amp — announce-only via amp.notifications + the kelbrin run wrapper",
  capabilities: {
    done: true,
    blocked: false,
    readAloud: false,
    slashCommand: false,
    instructionInjection: false,
  },

  detect(deps: AdapterDeps): Promise<Detection> {
    const installed = deps.which(BINARY) !== null || isDir(configDir(deps));
    return Promise.resolve({ installed });
  },

  wire(_deps: AdapterDeps): Promise<WireResult> {
    return Promise.resolve({
      changed: false,
      diff: "",
      warnings: [...FALLBACK_WARNINGS],
    });
  },

  unwire(_deps: AdapterDeps): Promise<void> {
    unwireFromLedger(LEDGER_KEY);
    return Promise.resolve();
  },

  normalize(raw: unknown, eventHint: EventName): KelbrinEvent | null {
    if (!isRecord(raw)) {
      return null;
    }
    const cwd = payloadCwd(raw);
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
