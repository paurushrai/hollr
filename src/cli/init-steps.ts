/**
 * The pure heart of `hollr init`: migrate, doctor, agent-wiring, and summary
 * steps that take an injected {@link InitIo} plus injected effects, so the whole
 * flow is driven by scripted answers in tests. @clack lives only in the `init.ts`
 * shell — never here.
 *
 * The wire contract this builds on: an adapter's {@link Adapter.wire} APPLIES the
 * change immediately (byte-reversibly, via the ledger) and returns the diff of
 * what it wrote — there is no deferred `apply()`. So the "show diff → confirm"
 * UX is realized as apply → show the returned diff → confirm-to-keep, reverting
 * with {@link Adapter.unwire} when the user declines. Nothing is fabricated and
 * every applied change is fully reversible.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listWiredKeys } from "../adapters/diffwire.ts";
import type { Adapter, AdapterCapabilities, AdapterDeps, Detection } from "../adapters/types.ts";
import type { Activation, HollrConfig } from "../core/config.ts";
import {
  DEFAULTS,
  hollrHome,
  isConfigured,
  loadConfig,
  migrateHttpOptIn,
} from "../core/config.ts";
import { allRequiredOk, checkAll, type Check } from "../core/doctor.ts";
import type { Platform } from "../platform/index.ts";
import { hardenConfig } from "../sinks/webhook.ts";
import { collectSinkConfig } from "./init-sinks.ts";

const CONFIG_FILE = "config.json";
const JSON_INDENT = 2;
/** The only fix `hollr init` will offer to run for the user (safe, idempotent). */
const XCODE_SELECT_FIX = "xcode-select --install";
const CHECK_MARK = "✓";
const CROSS_MARK = "✗";

/** One option for a select/multiselect prompt; `value` is what the flow reads back. */
export interface InitChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Everything `hollr init` needs from the outside world. The shell provides the
 * @clack-backed implementation; tests provide a scripted fake. Kept minimal:
 * exactly the four prompt kinds the flow uses, plus an informational note.
 */
export interface InitIo {
  multiselect<T extends string>(opts: {
    message: string;
    options: InitChoice<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]>;
  select<T extends string>(opts: {
    message: string;
    options: InitChoice<T>[];
    initialValue?: T;
  }): Promise<T>;
  text(opts: { message: string; placeholder?: string; initialValue?: string }): Promise<string>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  note(message: string, title?: string): void;
}

/**
 * Injected effects for the pure init flow. Config/ledger reads go straight to
 * `hollrHome()` (a temp dir in tests); only effects that would spawn or touch
 * the real home (`migrate`, `enumerateVoices`, `autoRunFix`, `detectV1`) are
 * injected so tests stay hermetic.
 */
export interface InitDeps {
  io: InitIo;
  adapters: Adapter[];
  platform: Platform;
  /** User home for adapter wiring/detection; a temp dir in tests. */
  home: string;
  which(bin: string): string | null;
  /** True when a v1 (Python) config exists and could be imported. */
  detectV1(): boolean;
  /** Run the one-time v1→v2 migration; returns whether it wrote a config. */
  migrate(): boolean;
  /** List installed TTS voices (spawns in prod; fixed list in tests). */
  enumerateVoices(): string[];
  /** Run a doctor fix command (only offered for {@link XCODE_SELECT_FIX}). */
  autoRunFix(command: string): void;
}

export interface InitOptions {
  yes: boolean;
}

export interface InitResult {
  runTest: boolean;
  configPath: string | null;
}

function adapterDeps(deps: InitDeps): AdapterDeps {
  return { home: deps.home, which: deps.which };
}

/** True when the ledger holds any key owned by adapter `id` (`<id>:<suffix>`). */
function isWired(wiredKeys: string[], id: string): boolean {
  return wiredKeys.some((key) => (key.split(":")[0] ?? key) === id);
}

/** Capability badges, e.g. `✓done ✓blocked ✓read-aloud ✗slash`. */
function capabilityBadges(caps: AdapterCapabilities): string {
  const badge = (ok: boolean, label: string): string =>
    `${ok ? CHECK_MARK : CROSS_MARK}${label}`;
  return [
    badge(caps.done, "done"),
    badge(caps.blocked, "blocked"),
    badge(caps.readAloud, "read-aloud"),
    badge(caps.slashCommand, "slash"),
  ].join(" ");
}

function agentOption(adapter: Adapter, detection: Detection): InitChoice<string> {
  const flags: string[] = [];
  if (!detection.installed) {
    flags.push("not detected");
  }
  if (detection.degraded !== undefined) {
    flags.push("degraded");
  }
  const badges = capabilityBadges(adapter.capabilities);
  const hint = flags.length === 0 ? badges : `${badges} · ${flags.join(", ")}`;
  return { value: adapter.id, label: `${adapter.title} — ${adapter.tagline}`, hint };
}

const CONFIG_MODE = 0o600;

/**
 * Serialize + write the global config at mode 0600 so it is owner-only from the
 * instant it is created (no world-readable window before hardening). `mode` only
 * applies on creation, so `hardenConfig` still chmods a pre-existing file that
 * gained secrets on a re-run.
 */
function writeGlobalConfig(config: HollrConfig): string {
  const home = hollrHome();
  mkdirSync(home, { recursive: true });
  const path = join(home, CONFIG_FILE);
  writeFileSync(path, `${JSON.stringify(config, null, JSON_INDENT)}\n`, {
    encoding: "utf8",
    mode: CONFIG_MODE,
  });
  hardenConfig(config.webhooks);
  return path;
}

/** On the beta platforms, warn up front that engines are not yet live-verified. */
function noteBetaPlatform(deps: InitDeps): void {
  if (deps.platform.id === "linux" || deps.platform.id === "win32") {
    deps.io.note(
      `${deps.platform.id} support is beta — engines are mock-tested, not yet live-verified.`,
      "Beta platform",
    );
  }
}

/** Offer to import a v1 config when one exists. */
async function stepMigrate(deps: InitDeps): Promise<void> {
  if (!deps.detectV1()) {
    return;
  }
  const doImport = await deps.io.confirm({
    message: "A hollr v1 config was found. Import it?",
    initialValue: true,
  });
  if (!doImport) {
    return;
  }
  const migrated = deps.migrate();
  deps.io.note(
    migrated ? "Imported your v1 config." : "Nothing imported (a v2 config already exists).",
  );
}

function formatFailingCheck(check: Check): string {
  const fix = check.fix === null ? "" : `\n   fix: ${check.fix}`;
  return `${CROSS_MARK} ${check.label} — ${check.detail}${fix}`;
}

/** Run doctor; on a missing required check, show fixes and ask whether to go on. */
async function stepDoctor(deps: InitDeps): Promise<boolean> {
  const checks = await checkAll({
    which: deps.which,
    platform: deps.platform,
    adapters: deps.adapters,
    home: deps.home,
  });
  if (allRequiredOk(checks)) {
    return true;
  }
  const failing = checks.filter((check) => check.required && !check.ok);
  deps.io.note(failing.map(formatFailingCheck).join("\n"), "Missing prerequisites");
  for (const check of failing) {
    if (check.fix === XCODE_SELECT_FIX) {
      const run = await deps.io.confirm({
        message: `Run \`${check.fix}\` now?`,
        initialValue: false,
      });
      if (run) {
        deps.autoRunFix(check.fix);
      }
    }
  }
  return deps.io.confirm({ message: "Continue setup anyway?", initialValue: false });
}

/** One plain-language line: which alerts/commands an agent was wired for. */
function wireSummary(adapter: Adapter): string {
  const caps = adapter.capabilities;
  const parts: string[] = [];
  const alerts: string[] = [];
  if (caps.done) {
    alerts.push("done");
  }
  if (caps.blocked) {
    alerts.push("needs-input");
  }
  if (alerts.length > 0) {
    parts.push(`${alerts.join(" + ")} alerts`);
  }
  if (caps.readAloud) {
    parts.push("read-aloud");
  }
  if (caps.slashCommand) {
    parts.push("/hollr command");
  }
  if (parts.length === 0) {
    return adapter.title;
  }
  return `${adapter.title}: ${parts.join(", ")}`;
}

/** Apply a wire, show a plain-language summary (raw diff only on request), and revert if the user rejects it. */
async function wireAgent(deps: InitDeps, adapter: Adapter): Promise<void> {
  const result = await adapter.wire(adapterDeps(deps));
  for (const warning of result.warnings) {
    deps.io.note(warning, "Warning");
  }
  if (!result.changed) {
    deps.io.note(`${adapter.title} is already configured.`);
    return;
  }
  deps.io.note(
    `${wireSummary(adapter)}\nSilence it here anytime with \`hollr off\`.`,
    `${adapter.title} — set up`,
  );
  const seeDiff = await deps.io.confirm({
    message: "Show exactly what changed?",
    initialValue: false,
  });
  if (seeDiff) {
    deps.io.note(result.diff, `${adapter.title} — changes applied`);
  }
  const keep = await deps.io.confirm({
    message: `Keep these changes to ${adapter.title}?`,
    initialValue: true,
  });
  if (!keep) {
    await adapter.unwire(adapterDeps(deps));
    deps.io.note(`Reverted ${adapter.title}.`);
  }
}

/** Multi-select agents, then wire newly-selected and unwire deselected ones. */
async function stepAgents(deps: InitDeps): Promise<void> {
  const detections = await Promise.all(
    deps.adapters.map((adapter) => adapter.detect(adapterDeps(deps))),
  );
  const wiredKeys = listWiredKeys();
  const options = deps.adapters.map((adapter, index) =>
    agentOption(adapter, detections[index] ?? { installed: false }),
  );
  const initialValues = deps.adapters
    .filter((adapter) => isWired(wiredKeys, adapter.id))
    .map((adapter) => adapter.id);
  const selected = await deps.io.multiselect<string>({
    message: "Select the agents hollr should wire (space to toggle)",
    options,
    initialValues,
    required: false,
  });
  const selectedSet = new Set(selected);
  for (const adapter of deps.adapters) {
    const wired = isWired(wiredKeys, adapter.id);
    const picked = selectedSet.has(adapter.id);
    if (picked && !wired) {
      await wireAgent(deps, adapter);
    } else if (!picked && wired) {
      await adapter.unwire(adapterDeps(deps));
      deps.io.note(`Unwired ${adapter.title}.`);
    }
  }
}

/** Ask, in plain words, whether hollr is on everywhere or only where turned on. */
async function stepActivation(io: InitIo, current: Activation): Promise<Activation> {
  const choice = await io.select<Activation>({
    message: "When should hollr speak up?",
    options: [
      { value: "all", label: "In every project — turn it off where you don't want it" },
      { value: "opt-in", label: "Only in projects I turn on" },
    ],
    initialValue: current,
  });
  if (choice === "opt-in") {
    io.note("hollr will stay quiet until you run `hollr on` inside a project.");
  }
  return choice;
}

/** Print a summary and offer to preview with `hollr test`. */
async function stepSummary(io: InitIo, config: HollrConfig): Promise<boolean> {
  const lines = [
    `done: ${config.events.done.mode}`,
    `blocked: ${config.events.blocked.mode}`,
    `error: ${config.events.error.mode}`,
    `voice: ${config.voice.name ?? "OS default"}`,
    `quiet hours: ${config.quietHours ?? "none"}`,
    `webhooks: ${config.webhooks.length}`,
  ];
  io.note(lines.join("\n"), "hollr is configured");
  return io.confirm({ message: "Preview it now with `hollr test`?", initialValue: true });
}

/**
 * Non-interactive setup (`--yes`): wire every detected agent. On a fresh install
 * (no config file) write DEFAULTS; on a re-run preserve the existing config so a
 * `--yes` never silently destroys configured sinks, webhooks, or secrets.
 */
async function runInitYes(deps: InitDeps): Promise<InitResult> {
  if (deps.detectV1()) {
    deps.migrate();
  }
  const detections = await Promise.all(
    deps.adapters.map((adapter) => adapter.detect(adapterDeps(deps))),
  );
  for (const [index, adapter] of deps.adapters.entries()) {
    if (detections[index]?.installed === true) {
      await adapter.wire(adapterDeps(deps));
    }
  }
  const cwd = process.cwd();
  const loaded = isConfigured(cwd) ? loadConfig(cwd) : structuredClone(DEFAULTS);
  // Close the legacy global http opt-in: move it onto the http targets that
  // relied on it, then clear the root flag so it can't widen a future target.
  const config = migrateHttpOptIn(loaded).config;
  const configPath = writeGlobalConfig(config);
  return { runTest: false, configPath };
}

/**
 * Run the full `hollr init` flow. Returns whether the caller should launch
 * `hollr test` and where the config was written (`null` when setup was aborted
 * at the doctor gate). Errors propagate — init is interactive, not a hook.
 */
export async function runInit(deps: InitDeps, opts: InitOptions): Promise<InitResult> {
  if (opts.yes) {
    return runInitYes(deps);
  }
  noteBetaPlatform(deps);
  await stepMigrate(deps);
  const proceed = await stepDoctor(deps);
  if (!proceed) {
    return { runTest: false, configPath: null };
  }
  await stepAgents(deps);
  // Loaded after migrate/agent wiring so a just-migrated config seeds the
  // prompts; loadConfig returns DEFAULTS when nothing exists, so this is the
  // universal base and never destroys the user's current sinks. The http
  // opt-in migration runs here so a re-init persists per-target flags and
  // clears the legacy root flag.
  const existing = migrateHttpOptIn(loadConfig(process.cwd())).config;
  const activation = await stepActivation(deps.io, existing.activation);
  const config = await collectSinkConfig(deps.io, deps.enumerateVoices, existing);
  config.activation = activation;
  const configPath = writeGlobalConfig(config);
  const runTest = await stepSummary(deps.io, config);
  return { runTest, configPath };
}
