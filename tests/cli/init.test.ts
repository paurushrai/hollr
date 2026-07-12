import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Adapter, AdapterDeps, Detection, WireResult } from "../../src/adapters/types.ts";
import type { Activation, HollrConfig } from "../../src/core/config.ts";
import { DEFAULTS } from "../../src/core/config.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { InitChoice, InitDeps, InitIo } from "../../src/cli/init-steps.ts";
import { runInit } from "../../src/cli/init-steps.ts";
import { collectSinkConfig } from "../../src/cli/init-sinks.ts";
import { runUninstall } from "../../src/cli/uninstall.ts";

let tmpRoot: string;
let hollrHomeDir: string;
let userHome: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-init-"));
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  userHome = join(tmpRoot, "home");
  mkdirSync(userHome, { recursive: true });
  prevHollrHome = process.env.HOLLR_HOME;
  process.env.HOLLR_HOME = hollrHomeDir;
});

afterEach(() => {
  if (prevHollrHome === undefined) {
    delete process.env.HOLLR_HOME;
  } else {
    process.env.HOLLR_HOME = prevHollrHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakePlatform(id: Platform["id"] = "darwin"): Platform {
  return {
    id,
    voiceArgv: () => null,
    notifyArgv: () => null,
    soundArgv: () => null,
    enumerateVoicesArgv: () => ["say", "-v", "?"],
    parseVoicesOutput: () => [],
    canPauseResume: true,
    requiredBinaries: [],
  };
}

/** A scripted, side-effect-free io: answers are dequeued per method in order. */
class ScriptIo implements InitIo {
  multiselectQueue: string[][] = [];
  selectQueue: string[] = [];
  textQueue: string[] = [];
  confirmQueue: boolean[] = [];
  notes: string[] = [];
  lastMultiselectHints: string[] = [];
  /** Every `select` call in order, so tests can inspect a specific prompt's seed. */
  selectCalls: Array<{ message: string; initialValue?: string }> = [];

  multiselect<T extends string>(opts: {
    message: string;
    options: InitChoice<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]> {
    this.lastMultiselectHints = opts.options.map((option) => option.hint ?? "");
    const next = this.multiselectQueue.shift();
    if (next === undefined) {
      throw new Error("no scripted multiselect answer");
    }
    return Promise.resolve(next as T[]);
  }

  select<T extends string>(opts: {
    message: string;
    options: InitChoice<T>[];
    initialValue?: T;
  }): Promise<T> {
    this.selectCalls.push({ message: opts.message, initialValue: opts.initialValue });
    const next = this.selectQueue.shift();
    if (next === undefined) {
      throw new Error("no scripted select answer");
    }
    return Promise.resolve(next as T);
  }

  text(opts: { message: string; placeholder?: string; initialValue?: string }): Promise<string> {
    void opts;
    const next = this.textQueue.shift();
    if (next === undefined) {
      throw new Error("no scripted text answer");
    }
    return Promise.resolve(next);
  }

  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean> {
    void opts;
    const next = this.confirmQueue.shift();
    if (next === undefined) {
      throw new Error("no scripted confirm answer");
    }
    return Promise.resolve(next);
  }

  note(message: string): void {
    this.notes.push(message);
  }

  notesText(): string {
    return this.notes.join("\n");
  }
}

interface FakeAdapterOptions {
  id: string;
  installed: boolean;
  degraded?: string;
  changed?: boolean;
  diff?: string;
}

function makeAdapter(
  opts: FakeAdapterOptions,
  spies: { wire: Mock; unwire: Mock },
): Adapter {
  const detection: Detection = { installed: opts.installed };
  if (opts.degraded !== undefined) {
    detection.degraded = opts.degraded;
  }
  const wireResult: WireResult = {
    changed: opts.changed ?? true,
    diff: opts.diff ?? `+ hook for ${opts.id}`,
    warnings: [],
  };
  return {
    id: opts.id,
    title: opts.id.toUpperCase(),
    tagline: `the ${opts.id} agent`,
    capabilities: { done: true, blocked: true, readAloud: true, slashCommand: false },
    detect: (_deps: AdapterDeps) => Promise.resolve(detection),
    wire: (deps: AdapterDeps) => {
      spies.wire(deps);
      return Promise.resolve(wireResult);
    },
    unwire: (deps: AdapterDeps) => {
      spies.unwire(deps);
      return Promise.resolve();
    },
    normalize: () => null,
    readLastResponse: () => Promise.resolve(null),
  };
}

function baseDeps(io: InitIo, adapters: Adapter[]): InitDeps {
  return {
    io,
    adapters,
    platform: fakePlatform(),
    home: userHome,
    which: () => "/usr/bin/node",
    detectV1: () => false,
    migrate: () => false,
    enumerateVoices: () => [],
    autoRunFix: () => {},
  };
}

function readWrittenConfig(): HollrConfig {
  return JSON.parse(readFileSync(join(hollrHomeDir, "config.json"), "utf8")) as HollrConfig;
}

function writeLedger(keys: string[]): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  const entries = keys.map((ledgerKey) => ({
    ledgerKey,
    path: join(userHome, `${ledgerKey}.json`),
    before: null,
    at: "2026-01-01T00:00:00.000Z",
  }));
  writeFileSync(join(hollrHomeDir, "wired.json"), JSON.stringify(entries));
}

/** Pre-write a global config so a run exercises the "re-run" (existing) path. */
function writeExistingConfig(config: HollrConfig): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  writeFileSync(join(hollrHomeDir, "config.json"), JSON.stringify(config));
}

/** A config with a webhook (auth header) + custom voice + quiet hours to preserve. */
function configuredConfig(): HollrConfig {
  return {
    ...structuredClone(DEFAULTS),
    events: { done: { mode: "silent" }, blocked: { mode: "announce" }, error: { mode: "notify" } },
    voice: { name: "Samantha", rateWpm: 210 },
    quietHours: "22:00-08:00",
    quietHoursWebhooks: "suppress",
    webhooks: [
      {
        name: "prod",
        provider: "generic",
        url: "https://hooks.example",
        events: ["done", "error"],
        headers: { Authorization: "Bearer secret" },
      },
    ],
    allowHttp: false,
  };
}

/**
 * Queue answers for the activation prompt (runs between stepAgents and
 * collectSinkConfig) plus the default sink flow (all defaults, no webhooks).
 */
function scriptDefaultSinks(io: ScriptIo, activation: Activation = "all"): void {
  io.selectQueue.push(activation); // "When should hollr speak up?"
  io.selectQueue.push("announce", "announce", "notify"); // done/blocked/error modes
  io.confirmQueue.push(false); // enumerate voices? no
  io.textQueue.push(""); // sound name -> none
  io.textQueue.push(""); // quiet hours -> none
  io.confirmQueue.push(false); // add webhook? no
}

describe("runInit", () => {
  it("should_wire_selected_agent_and_write_default_config_on_happy_path", async () => {
    const wire = vi.fn();
    const unwire = vi.fn();
    const adapter = makeAdapter({ id: "a1", installed: true }, { wire, unwire });
    const io = new ScriptIo();
    io.multiselectQueue.push(["a1"]); // select a1
    io.confirmQueue.push(false); // show exactly what changed? no
    io.confirmQueue.push(true); // keep wire changes
    scriptDefaultSinks(io);
    io.confirmQueue.push(true); // preview with hollr test

    const result = await runInit(baseDeps(io, [adapter]), { yes: false });

    expect(wire).toHaveBeenCalledTimes(1);
    expect(unwire).not.toHaveBeenCalled();
    expect(result.runTest).toBe(true);
    const config = readWrittenConfig();
    expect(config.events.done.mode).toBe("announce");
    expect(config.webhooks).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "should_create_the_global_config_owner_only_0600",
    async () => {
      const adapter = makeAdapter(
        { id: "a1", installed: true },
        { wire: vi.fn(), unwire: vi.fn() },
      );
      const io = new ScriptIo();
      io.multiselectQueue.push([]); // wire nothing
      scriptDefaultSinks(io);
      io.confirmQueue.push(false); // no test

      await runInit(baseDeps(io, [adapter]), { yes: false });

      const mode = statSync(join(hollrHomeDir, "config.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it("should_unwire_when_a_previously_wired_agent_is_deselected", async () => {
    writeLedger(["a1:cfg"]);
    const wire = vi.fn();
    const unwire = vi.fn();
    const adapter = makeAdapter({ id: "a1", installed: true }, { wire, unwire });
    const io = new ScriptIo();
    io.multiselectQueue.push([]); // deselect a1
    scriptDefaultSinks(io);
    io.confirmQueue.push(false); // no test

    await runInit(baseDeps(io, [adapter]), { yes: false });

    expect(unwire).toHaveBeenCalledTimes(1);
    expect(wire).not.toHaveBeenCalled();
  });

  it("should_annotate_degraded_and_undetected_agents_in_the_multiselect", async () => {
    const adapter = makeAdapter(
      { id: "leg", installed: true, degraded: "legacy integration" },
      { wire: vi.fn(), unwire: vi.fn() },
    );
    const absent = makeAdapter({ id: "gone", installed: false }, { wire: vi.fn(), unwire: vi.fn() });
    const io = new ScriptIo();
    io.multiselectQueue.push([]); // select nothing
    scriptDefaultSinks(io);
    io.confirmQueue.push(false);

    await runInit(baseDeps(io, [adapter, absent]), { yes: false });

    expect(io.lastMultiselectHints[0]).toContain("degraded");
    expect(io.lastMultiselectHints[0]).toContain("✓read-aloud");
    expect(io.lastMultiselectHints[1]).toContain("not detected");
  });

  it("should_revert_a_wire_when_the_user_declines_to_keep_it", async () => {
    const wire = vi.fn();
    const unwire = vi.fn();
    const adapter = makeAdapter({ id: "a1", installed: true }, { wire, unwire });
    const io = new ScriptIo();
    io.multiselectQueue.push(["a1"]);
    io.confirmQueue.push(false); // show exactly what changed? no
    io.confirmQueue.push(false); // do NOT keep the changes -> revert
    scriptDefaultSinks(io);
    io.confirmQueue.push(false);

    await runInit(baseDeps(io, [adapter]), { yes: false });

    expect(wire).toHaveBeenCalledTimes(1);
    expect(unwire).toHaveBeenCalledTimes(1);
    expect(io.notesText()).toContain("Reverted");
  });

  it("shows a human wiring summary and hides raw JSON by default", async () => {
    const adapter = makeAdapter(
      { id: "a1", installed: true, diff: '{"hooks": {"Stop": ["say done"]}}' },
      { wire: vi.fn(), unwire: vi.fn() },
    );
    const io = new ScriptIo();
    io.multiselectQueue.push(["a1"]); // select a1
    io.confirmQueue.push(false); // show exactly what changed? no
    io.confirmQueue.push(true); // keep wire changes
    scriptDefaultSinks(io);
    io.confirmQueue.push(false); // preview? no

    await runInit(baseDeps(io, [adapter]), { yes: false });

    const noted = io.notesText();
    expect(noted).toContain("A1:"); // human summary
    expect(noted).not.toContain('"hooks"'); // no raw JSON
  });

  it("reveals the full diff when the user asks", async () => {
    const adapter = makeAdapter(
      { id: "a1", installed: true, diff: '{"hooks": {"Stop": ["say done"]}}' },
      { wire: vi.fn(), unwire: vi.fn() },
    );
    const io = new ScriptIo();
    io.multiselectQueue.push(["a1"]); // select a1
    io.confirmQueue.push(true); // show exactly what changed? yes
    io.confirmQueue.push(true); // keep wire changes
    scriptDefaultSinks(io);
    io.confirmQueue.push(false); // preview? no

    await runInit(baseDeps(io, [adapter]), { yes: false });

    expect(io.notesText()).toContain('"hooks"'); // raw diff on demand
  });

  it("should_import_v1_config_when_detected_and_confirmed", async () => {
    const migrate = vi.fn(() => true);
    const io = new ScriptIo();
    io.confirmQueue.push(true); // import v1?
    io.multiselectQueue.push([]);
    scriptDefaultSinks(io);
    io.confirmQueue.push(false);
    const deps = { ...baseDeps(io, []), detectV1: () => true, migrate };

    await runInit(deps, { yes: false });

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(io.notesText()).toContain("Imported");
  });

  it("should_show_fixes_and_offer_xcode_autorun_then_stop_when_declined", async () => {
    const autoRunFix = vi.fn();
    const platform: Platform = {
      ...fakePlatform(),
      requiredBinaries: [{ name: "say", fix: "xcode-select --install" }],
    };
    const io = new ScriptIo();
    io.confirmQueue.push(true); // run xcode-select --install?
    io.confirmQueue.push(false); // continue anyway? no -> stop
    const deps: InitDeps = {
      ...baseDeps(io, []),
      platform,
      which: () => null, // 'say' missing -> required check fails
      autoRunFix,
    };

    const result = await runInit(deps, { yes: false });

    expect(autoRunFix).toHaveBeenCalledWith("xcode-select --install");
    expect(result.configPath).toBeNull();
    expect(() => readWrittenConfig()).toThrow();
  });

  it("should_note_the_beta_warning_on_linux", async () => {
    const io = new ScriptIo();
    io.multiselectQueue.push([]);
    scriptDefaultSinks(io);
    io.confirmQueue.push(false);
    const deps: InitDeps = { ...baseDeps(io, []), platform: fakePlatform("linux") };

    await runInit(deps, { yes: false });

    expect(io.notesText().toLowerCase()).toContain("beta");
  });

  it("should_wire_only_detected_agents_without_prompting_when_yes", async () => {
    const wireOn = vi.fn();
    const unwireOn = vi.fn();
    const wireOff = vi.fn();
    const unwireOff = vi.fn();
    const detected = makeAdapter({ id: "on", installed: true }, { wire: wireOn, unwire: unwireOn });
    const absent = makeAdapter({ id: "off", installed: false }, { wire: wireOff, unwire: unwireOff });
    const io = new ScriptIo(); // must never be consulted

    const result = await runInit(baseDeps(io, [detected, absent]), { yes: true });

    expect(wireOn).toHaveBeenCalledTimes(1);
    expect(wireOff).not.toHaveBeenCalled();
    expect(result.runTest).toBe(false);
    const config = readWrittenConfig();
    expect(config.version).toBe(2);
    expect(config.webhooks).toEqual([]);
    expect(config.voice.name).toBeNull();
  });

  it("should_preserve_existing_sinks_on_yes_when_a_config_already_exists", async () => {
    writeExistingConfig(configuredConfig());
    const adapter = makeAdapter({ id: "a1", installed: true }, { wire: vi.fn(), unwire: vi.fn() });
    const io = new ScriptIo(); // never consulted with --yes

    await runInit(baseDeps(io, [adapter]), { yes: true });

    const config = readWrittenConfig();
    expect(config.webhooks).toHaveLength(1);
    expect(config.webhooks[0]?.url).toBe("https://hooks.example");
    expect(config.webhooks[0]?.headers).toEqual({ Authorization: "Bearer secret" });
    expect(config.voice).toEqual({ name: "Samantha", rateWpm: 210 });
    expect(config.quietHours).toBe("22:00-08:00");
    expect(config.quietHoursWebhooks).toBe("suppress");
  });

  it("should_migrate_legacy_global_allowHttp_onto_http_targets_on_yes", async () => {
    writeExistingConfig({
      ...configuredConfig(),
      allowHttp: true,
      webhooks: [
        { name: "local", provider: "generic", url: "http://localhost:8080", events: ["done"] },
        { name: "prod", provider: "generic", url: "https://hooks.example", events: ["done"] },
      ],
    });
    const adapter = makeAdapter({ id: "a1", installed: true }, { wire: vi.fn(), unwire: vi.fn() });

    await runInit(baseDeps(new ScriptIo(), [adapter]), { yes: true });

    const config = readWrittenConfig();
    expect(config.allowHttp).toBe(false); // legacy root flag cleared
    expect(config.webhooks[0]?.allowHttp).toBe(true); // http target keeps working
    expect(config.webhooks[1]?.allowHttp).toBeUndefined(); // https untouched
  });

  it("should_preserve_existing_webhooks_and_unprompted_settings_on_interactive_re_run", async () => {
    writeExistingConfig({ ...configuredConfig(), voice: { name: null, rateWpm: 240 } });
    const adapter = makeAdapter({ id: "a1", installed: false }, { wire: vi.fn(), unwire: vi.fn() });
    const io = new ScriptIo();
    io.multiselectQueue.push([]); // wire no agents
    io.selectQueue.push("all"); // "When should hollr speak up?" (accept existing)
    io.selectQueue.push("silent", "announce", "notify"); // accept existing modes
    io.confirmQueue.push(false); // choose installed voices? no -> OS default
    io.textQueue.push(""); // sound -> none
    io.textQueue.push(""); // quiet hours -> none
    io.confirmQueue.push(false); // add a webhook? no (existing seeded)
    io.confirmQueue.push(false); // preview? no

    await runInit(baseDeps(io, [adapter]), { yes: false });

    const config = readWrittenConfig();
    expect(config.webhooks).toHaveLength(1);
    expect(config.webhooks[0]?.headers).toEqual({ Authorization: "Bearer secret" });
    expect(config.events.done.mode).toBe("silent");
    // rateWpm is never prompted: proves the base is the existing config, not DEFAULTS.
    expect(config.voice.rateWpm).toBe(240);
  });

  it("stores the chosen activation from setup", async () => {
    const io = new ScriptIo();
    io.multiselectQueue.push([]); // wire no agents
    scriptDefaultSinks(io, "opt-in"); // "speak up" select -> "opt-in"
    io.confirmQueue.push(false); // preview? no

    await runInit(baseDeps(io, []), { yes: false });

    const config = readWrittenConfig();
    expect(config.activation).toBe("opt-in");
  });

  it("seeds the initial activation from an existing config on re-run", async () => {
    writeExistingConfig({ ...structuredClone(DEFAULTS), activation: "opt-in" });
    const io = new ScriptIo();
    io.multiselectQueue.push([]); // wire no agents
    scriptDefaultSinks(io, "opt-in"); // answer doesn't matter for this assertion
    io.confirmQueue.push(false); // preview? no

    await runInit(baseDeps(io, []), { yes: false });

    const activationCall = io.selectCalls.find((call) => call.message.includes("speak up"));
    expect(activationCall?.initialValue).toBe("opt-in");
  });
});

describe("collectSinkConfig webhook https validation", () => {
  it("should_reject_http_url_then_accept_https_without_allowHttp", async () => {
    const io = new ScriptIo();
    io.selectQueue.push("announce", "announce", "notify");
    io.confirmQueue.push(false); // voices
    io.textQueue.push(""); // sound
    io.textQueue.push(""); // quiet hours
    io.confirmQueue.push(true); // add webhook
    io.selectQueue.push("generic"); // provider
    io.textQueue.push("prod"); // name
    io.textQueue.push("http://insecure.example"); // url attempt 1 (http)
    io.confirmQueue.push(false); // allow insecure http? no
    io.textQueue.push("https://secure.example"); // url attempt 2 (https)
    io.multiselectQueue.push(["done", "blocked", "error"]); // events
    io.confirmQueue.push(false); // add headers? no
    io.confirmQueue.push(false); // add another webhook? no

    const config = await collectSinkConfig(io, () => [], structuredClone(DEFAULTS));

    expect(config.allowHttp).toBe(false);
    expect(config.webhooks).toHaveLength(1);
    expect(config.webhooks[0]?.url).toBe("https://secure.example");
  });

  it("should_select_an_enumerated_voice_and_set_quiet_hours_with_webhook_policy", async () => {
    const io = new ScriptIo();
    io.selectQueue.push("readaloud", "notify", "silent"); // modes
    io.confirmQueue.push(true); // pick from installed voices
    io.selectQueue.push("Samantha"); // voice
    io.textQueue.push("Glass"); // sound
    io.textQueue.push("bad"); // quiet hours invalid -> re-prompt
    io.textQueue.push("22:00-08:00"); // quiet hours valid
    io.selectQueue.push("suppress"); // quiet-hours webhook policy
    io.confirmQueue.push(false); // add webhook? no

    const config = await collectSinkConfig(io, () => ["Alex", "Samantha"], structuredClone(DEFAULTS));

    expect(config.events.done.mode).toBe("readaloud");
    expect(config.voice.name).toBe("Samantha");
    expect(config.notify.sound).toBe("Glass");
    expect(config.quietHours).toBe("22:00-08:00");
    expect(config.quietHoursWebhooks).toBe("suppress");
    expect(io.notesText()).toContain("Invalid format");
  });

  it("should_fall_back_to_os_default_when_no_voices_are_enumerated", async () => {
    const io = new ScriptIo();
    io.selectQueue.push("announce", "announce", "notify");
    io.confirmQueue.push(true); // pick installed voices
    io.textQueue.push(""); // sound
    io.textQueue.push(""); // quiet
    io.confirmQueue.push(false); // webhook

    const config = await collectSinkConfig(io, () => [], structuredClone(DEFAULTS));

    expect(config.voice.name).toBeNull();
    expect(io.notesText()).toContain("OS default");
  });

  it("should_attach_headers_to_a_webhook_target", async () => {
    const io = new ScriptIo();
    io.selectQueue.push("announce", "announce", "notify");
    io.confirmQueue.push(false); // voices
    io.textQueue.push(""); // sound
    io.textQueue.push(""); // quiet
    io.confirmQueue.push(true); // add webhook
    io.selectQueue.push("pushover"); // provider (also emits the token/user note)
    io.textQueue.push("po"); // name
    io.textQueue.push("https://api.pushover.net"); // url
    io.multiselectQueue.push(["done", "blocked", "error"]); // events
    io.confirmQueue.push(true); // add headers
    io.textQueue.push("token"); // header name
    io.textQueue.push("abc123"); // header value
    io.confirmQueue.push(false); // add another header? no
    io.confirmQueue.push(false); // add another webhook? no

    const config = await collectSinkConfig(io, () => [], structuredClone(DEFAULTS));

    expect(config.webhooks[0]?.headers).toEqual({ token: "abc123" });
    expect(io.notesText().toLowerCase()).toContain("pushover");
  });

  it("should_set_per_target_allowHttp_and_leave_root_flag_false_on_http_opt_in", async () => {
    const io = new ScriptIo();
    io.selectQueue.push("announce", "announce", "notify");
    io.confirmQueue.push(false); // voices
    io.textQueue.push(""); // sound
    io.textQueue.push(""); // quiet
    io.confirmQueue.push(true); // add webhook
    io.selectQueue.push("ntfy"); // provider
    io.textQueue.push("local"); // name
    io.textQueue.push("http://localhost:8080"); // url
    io.confirmQueue.push(true); // allow insecure http? yes
    io.multiselectQueue.push(["done"]); // events
    io.confirmQueue.push(false); // headers? no
    io.confirmQueue.push(false); // another? no

    const config = await collectSinkConfig(io, () => [], structuredClone(DEFAULTS));

    // Opt-in is scoped to the target, never widened to a config-wide flag.
    expect(config.webhooks[0]?.url).toBe("http://localhost:8080");
    expect(config.webhooks[0]?.allowHttp).toBe(true);
    expect(config.allowHttp).toBe(false);
  });

  it("should_not_let_one_http_opt_in_permit_a_second_http_target", async () => {
    const io = new ScriptIo();
    io.selectQueue.push("announce", "announce", "notify");
    io.confirmQueue.push(false); // voices
    io.textQueue.push(""); // sound
    io.textQueue.push(""); // quiet
    io.confirmQueue.push(true); // add webhook #1
    io.selectQueue.push("ntfy"); // provider
    io.textQueue.push("opted-in"); // name
    io.textQueue.push("http://a.example"); // url
    io.confirmQueue.push(true); // allow insecure http? yes
    io.multiselectQueue.push(["done"]); // events
    io.confirmQueue.push(false); // headers? no
    io.confirmQueue.push(true); // add webhook #2
    io.selectQueue.push("ntfy"); // provider
    io.textQueue.push("declined"); // name
    io.textQueue.push("http://b.example"); // url
    io.confirmQueue.push(false); // allow insecure http? NO
    io.textQueue.push("https://b.example"); // re-prompt → give https
    io.multiselectQueue.push(["done"]); // events
    io.confirmQueue.push(false); // headers? no
    io.confirmQueue.push(false); // another? no

    const config = await collectSinkConfig(io, () => [], structuredClone(DEFAULTS));

    expect(config.webhooks[0]?.allowHttp).toBe(true);
    // The declined second target never inherits the first's opt-in.
    expect(config.webhooks[1]?.allowHttp).toBeUndefined();
    expect(config.allowHttp).toBe(false);
  });
});

describe("runUninstall", () => {
  it("should_unwire_every_key_and_delete_home_on_double_confirm", async () => {
    writeLedger(["a1:cfg", "b2:cfg"]);
    const io = new ScriptIo();
    io.confirmQueue.push(true); // unwire all
    io.confirmQueue.push(true); // delete home

    const code = await runUninstall(io);

    expect(code).toBe(0);
    expect(() => readFileSync(join(hollrHomeDir, "wired.json"), "utf8")).toThrow();
  });

  it("should_stop_when_the_user_declines_the_first_confirm", async () => {
    writeLedger(["a1:cfg"]);
    const io = new ScriptIo();
    io.confirmQueue.push(false); // decline

    const code = await runUninstall(io);

    expect(code).toBe(0);
    const ledger = readFileSync(join(hollrHomeDir, "wired.json"), "utf8");
    expect(ledger).toContain("a1:cfg");
  });
});
