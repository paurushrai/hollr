/**
 * Prerequisite checks for kelbrin. `checkAll()` inspects the host for the Node
 * runtime, the current platform's required binaries, and any installed agent
 * adapters, returning one {@link Check} per prerequisite with a copy-paste
 * `fix` where one exists.
 *
 * It must be safe to call unconditionally on any machine — including a bare one
 * missing everything — so it never spawns a shell, never evals, and swallows a
 * throwing adapter probe rather than crashing.
 */

import { homedir } from "node:os";

import type { AdapterDeps } from "../adapters/types.ts";
import type { Platform } from "../platform/index.ts";

/** One prerequisite's result. */
export interface Check {
  /** Stable identifier (binary name, `node`, or an adapter id). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Whether the prerequisite is satisfied. */
  ok: boolean;
  /** True when a failure blocks kelbrin; optional/informational checks are false. */
  required: boolean;
  /** Present/missing detail (includes the resolved path when found). */
  detail: string;
  /** Copy-paste fix command, or `null` when there is nothing to run. */
  fix: string | null;
}

/**
 * Minimal structural type an agent adapter satisfies so the doctor can probe
 * it. Owned here (not imported from `adapters/`) so this compiles before the
 * adapter registry exists; the real `Adapter` structurally satisfies it.
 */
export interface DetectableAgent {
  id: string;
  title: string;
  detect(deps: AdapterDeps): Promise<{ installed: boolean; degraded?: string }>;
}

/** Minimum supported Node.js major version. */
const MIN_NODE_MAJOR = 20;
const NODE_KEY = "node";
const NODE_LABEL = "Node.js";
const NODE_FIX = `upgrade Node to >= ${MIN_NODE_MAJOR}`;

const BETA_NOTES: Partial<Record<Platform["id"], string>> = {
  linux: "Linux support is beta — engines are mock-tested, not yet live-verified.",
  win32: "Windows support is beta — engines are mock-tested, not yet live-verified.",
};

/** Strip a single leading `v` from a version string; the one source of truth. */
function stripVersionPrefix(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

/** Parse the major version from a semver-ish string, or `null` if unparseable. */
function parseMajor(version: string): number | null {
  const major = Number.parseInt(stripVersionPrefix(version).split(".")[0] ?? "", 10);
  return Number.isNaN(major) ? null : major;
}

function checkNode(nodeVersion: string): Check {
  const major = parseMajor(nodeVersion);
  const ok = major !== null && major >= MIN_NODE_MAJOR;
  const version = `v${stripVersionPrefix(nodeVersion)}`;
  const detail = ok
    ? `${version} (>= ${MIN_NODE_MAJOR} required)`
    : `${version} is too old (>= ${MIN_NODE_MAJOR} required)`;
  return {
    key: NODE_KEY,
    label: NODE_LABEL,
    ok,
    required: true,
    detail,
    fix: ok ? null : NODE_FIX,
  };
}

function checkBinaries(
  platform: Platform,
  which: (bin: string) => string | null,
): Check[] {
  const betaNote = BETA_NOTES[platform.id];
  return platform.requiredBinaries.map((entry) => {
    const resolved = which(entry.name);
    const ok = resolved !== null;
    let detail = ok ? `found at ${resolved}` : "not found on PATH";
    if (betaNote !== undefined) {
      detail = `${detail} — ${betaNote}`;
    }
    return {
      key: entry.name,
      label: entry.name,
      ok,
      required: entry.optional !== true,
      detail,
      fix: entry.fix,
    };
  });
}

async function checkAdapter(
  agent: DetectableAgent,
  deps: AdapterDeps,
): Promise<Check> {
  let ok = false;
  let detail = "not installed";
  try {
    const result = await agent.detect(deps);
    ok = result.installed;
    if (result.installed) {
      detail =
        result.degraded === undefined
          ? "installed"
          : `installed (degraded: ${result.degraded})`;
    }
  } catch {
    // A throwing probe must never crash the doctor — treat as not installed.
    detail = "not installed (detection failed)";
  }
  return { key: agent.id, label: agent.title, ok, required: false, detail, fix: null };
}

/** Run every prerequisite check. Never throws. */
export async function checkAll(deps: {
  which(bin: string): string | null;
  platform: Platform;
  adapters?: DetectableAgent[];
  nodeVersion?: string;
  /** User home for adapter detection; defaults to the real home dir. */
  home?: string;
}): Promise<Check[]> {
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const adapterDeps: AdapterDeps = {
    home: deps.home ?? homedir(),
    which: deps.which,
  };
  const adapterChecks = await Promise.all(
    (deps.adapters ?? []).map((agent) => checkAdapter(agent, adapterDeps)),
  );
  return [
    checkNode(nodeVersion),
    ...checkBinaries(deps.platform, deps.which),
    ...adapterChecks,
  ];
}

/** True iff every required check passed; optional/informational never count. */
export function allRequiredOk(checks: Check[]): boolean {
  return checks.every((check) => !check.required || check.ok);
}
