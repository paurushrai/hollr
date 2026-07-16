import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KelbrinConfig } from "../../src/core/config.ts";
import { DEFAULTS, encodeCwd, loadConfig, quietUntilPath } from "../../src/core/config.ts";
import type { KelbrinEvent } from "../../src/core/events.ts";
import { projectLabel } from "../../src/core/events.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { RouterDeps } from "../../src/core/router.ts";
import { route } from "../../src/core/router.ts";
import type { SpeakSequencedOptions } from "../../src/platform/sequencer.ts";

const CWD = "/Users/me/dev/my-app";
const NOW = new Date(2026, 6, 11, 12, 0);
const QUIET_NOW = new Date(2026, 6, 11, 23, 0);

let tmpRoot: string;
let kelbrinHomeDir: string;
let prevKelbrinHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-router-"));
  kelbrinHomeDir = join(tmpRoot, ".config", "kelbrin");
  prevKelbrinHome = process.env.KELBRIN_HOME;
  process.env.KELBRIN_HOME = kelbrinHomeDir;
});

afterEach(() => {
  if (prevKelbrinHome === undefined) {
    delete process.env.KELBRIN_HOME;
  } else {
    process.env.KELBRIN_HOME = prevKelbrinHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeGlobalRaw(raw: string): void {
  mkdirSync(kelbrinHomeDir, { recursive: true });
  writeFileSync(join(kelbrinHomeDir, "config.json"), raw);
}

function configure(overrides: Record<string, unknown> = {}): KelbrinConfig {
  writeGlobalRaw(JSON.stringify(overrides));
  return loadConfig(CWD);
}

function touchMute(cwd: string): void {
  const dir = join(kelbrinHomeDir, "projects");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encodeCwd(cwd)}.muted`), "");
}

function touchEnabled(cwd: string): void {
  const dir = join(kelbrinHomeDir, "projects");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encodeCwd(cwd)}.enabled`), "");
}

function setQuietUntil(value: string): void {
  mkdirSync(kelbrinHomeDir, { recursive: true });
  writeFileSync(quietUntilPath(), value);
}

function fired(mocks: Mocks): boolean {
  return (
    mocks.speak.mock.calls.length +
      mocks.notify.mock.calls.length +
      mocks.webhooks.mock.calls.length >
    0
  );
}

function fakePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: "darwin",
    voiceArgv: () => ["say", "text"],
    notifyArgv: (title, body) => ["notify", title, body],
    soundArgv: () => ["afplay", "sound"],
    enumerateVoicesArgv: () => null,
    parseVoicesOutput: () => [],
    canPauseResume: false,
    requiredBinaries: [],
    ...overrides,
  };
}

interface Mocks {
  deps: RouterDeps;
  speak: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  webhooks: ReturnType<typeof vi.fn>;
}

function makeDeps(platform: Platform = fakePlatform()): Mocks {
  const speak = vi.fn<(opts: SpeakSequencedOptions) => void>();
  const notify = vi.fn<(argv: string[]) => void>();
  const webhooks = vi.fn<(ev: KelbrinEvent) => void>();
  return { deps: { platform, speak, notify, webhooks }, speak, notify, webhooks };
}

function makeEvent(overrides: Partial<KelbrinEvent> = {}): KelbrinEvent {
  return {
    v: 1,
    ts: "2026-07-11T12:00:00.000Z",
    agent: "claude-code",
    agentTitle: "Claude Code",
    event: "done",
    cwd: CWD,
    project: projectLabel(CWD),
    summary: "",
    lastResponse: null,
    ...overrides,
  };
}

function spokenText(speak: ReturnType<typeof vi.fn>): string {
  const call = speak.mock.calls[0];
  expect(call).toBeDefined();
  return (call?.[0] as SpeakSequencedOptions).text;
}

describe("route: ported v1 hook behaviors", () => {
  it("should_speak_and_notify_on_done_announce", () => {
    const cfg = configure();
    const { deps, speak, notify } = makeDeps();
    const code = route(makeEvent(), cfg, deps, NOW);
    expect(code).toBe(0);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(spokenText(speak)).toBe("Claude Code response is ready in my app");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toEqual([
      "notify",
      "kelbrin",
      "Claude Code response is ready in my app",
    ]);
  });

  it("should_use_the_blocked_line_for_blocked_announce", () => {
    const cfg = configure();
    const { deps, speak } = makeDeps();
    route(makeEvent({ event: "blocked" }), cfg, deps, NOW);
    expect(spokenText(speak)).toBe("Claude Code needs your input in my app");
  });

  it("should_print_hint_once_and_return_1_then_0_when_unconfigured", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { deps, speak, notify, webhooks } = makeDeps();
    const cfg = loadConfig(CWD); // defaults; no files written
    const first = route(makeEvent(), cfg, deps, NOW);
    const second = route(makeEvent(), cfg, deps, NOW);
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("kelbrin: not configured");
    expect(existsSync(join(kelbrinHomeDir, "hint-shown"))).toBe(true);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(webhooks).not.toHaveBeenCalled();
  });

  it("should_be_fully_silent_when_muted", () => {
    const cfg = configure();
    touchMute(CWD);
    const { deps, speak, notify, webhooks } = makeDeps();
    const code = route(makeEvent(), cfg, deps, NOW);
    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(webhooks).not.toHaveBeenCalled();
  });

  it("should_skip_speak_but_keep_notify_in_quiet_hours", () => {
    const cfg = configure({ quietHours: "22:00-08:00" });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, QUIET_NOW);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("should_not_speak_or_notify_in_silent_mode", () => {
    const cfg = configure({ events: { done: { mode: "silent" } } });
    const { deps, speak, notify } = makeDeps();
    const code = route(makeEvent(), cfg, deps, NOW);
    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("should_notify_without_voice_in_notify_mode", () => {
    const cfg = configure({ events: { done: { mode: "notify" } } });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("should_read_last_response_in_readaloud_mode", () => {
    const cfg = configure({ events: { done: { mode: "readaloud" } } });
    const { deps, speak } = makeDeps();
    route(
      makeEvent({ lastResponse: "Refactor complete. All 42 tests pass." }),
      cfg,
      deps,
      NOW,
    );
    expect(spokenText(speak)).toBe("Refactor complete. All 42 tests pass.");
  });

  it("should_fall_back_to_announce_line_when_last_response_absent", () => {
    const cfg = configure({ events: { done: { mode: "readaloud" } } });
    const { deps, speak } = makeDeps();
    route(makeEvent({ lastResponse: null }), cfg, deps, NOW);
    expect(spokenText(speak)).toBe("Claude Code response is ready in my app");
  });

  it("should_fall_back_to_announce_line_when_last_response_empty", () => {
    const cfg = configure({ events: { done: { mode: "readaloud" } } });
    const { deps, speak } = makeDeps();
    route(makeEvent({ lastResponse: "   " }), cfg, deps, NOW);
    expect(spokenText(speak)).toBe("Claude Code response is ready in my app");
  });

  it("should_downgrade_readaloud_to_announce_on_non_done_event", () => {
    const cfg = configure({ events: { blocked: { mode: "readaloud" } } });
    const { deps, speak } = makeDeps();
    route(
      makeEvent({ event: "blocked", lastResponse: "some long text" }),
      cfg,
      deps,
      NOW,
    );
    expect(spokenText(speak)).toBe("Claude Code needs your input in my app");
  });

  it("should_skip_desktop_notify_when_desktop_false_on_announce", () => {
    const cfg = configure({ notify: { desktop: false } });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("should_pass_sound_to_speak_when_configured", () => {
    const cfg = configure({ notify: { desktop: true, sound: "Glass" } });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0]?.[0] as SpeakSequencedOptions).sound).toBe("Glass");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("should_suppress_sound_and_voice_but_keep_notify_in_quiet_hours", () => {
    const cfg = configure({
      quietHours: "22:00-08:00",
      notify: { desktop: true, sound: "Glass" },
    });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, QUIET_NOW);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("should_play_sound_without_voice_in_notify_mode_with_sound", () => {
    const cfg = configure({
      events: { done: { mode: "notify" } },
      notify: { desktop: true, sound: "Glass" },
    });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(speak).toHaveBeenCalledTimes(1);
    const opts = speak.mock.calls[0]?.[0] as SpeakSequencedOptions;
    expect(opts.text).toBe("");
    expect(opts.sound).toBe("Glass");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("should_not_throw_and_return_0_on_type_wrong_config", () => {
    const cfg = configure({ events: "loud", voice: { rateWpm: "fast" } });
    const { deps, speak, notify } = makeDeps();
    let code: number | undefined;
    expect(() => {
      code = route(makeEvent(), cfg, deps, NOW);
    }).not.toThrow();
    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("should_still_speak_and_notify_with_a_bad_rate", () => {
    const cfg = configure({ voice: { name: "Samantha", rateWpm: "fast" } });
    const { deps, speak, notify } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("route: error events and webhooks", () => {
  it("should_notify_by_default_on_error_event", () => {
    const cfg = configure();
    const { deps, speak, notify } = makeDeps();
    route(makeEvent({ event: "error" }), cfg, deps, NOW);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toEqual([
      "notify",
      "kelbrin",
      "Claude Code hit an error in my app",
    ]);
  });

  it("should_fire_webhooks_for_a_configured_done_event", () => {
    const cfg = configure();
    const { deps, webhooks } = makeDeps();
    const ev = makeEvent();
    route(ev, cfg, deps, NOW);
    expect(webhooks).toHaveBeenCalledTimes(1);
    expect(webhooks.mock.calls[0]?.[0]).toBe(ev);
  });

  it("should_fire_webhooks_even_in_silent_mode", () => {
    const cfg = configure({ events: { done: { mode: "silent" } } });
    const { deps, webhooks } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(webhooks).toHaveBeenCalledTimes(1);
  });

  it("should_skip_webhooks_when_muted", () => {
    const cfg = configure();
    touchMute(CWD);
    const { deps, webhooks } = makeDeps();
    route(makeEvent(), cfg, deps, NOW);
    expect(webhooks).not.toHaveBeenCalled();
  });

  it("should_skip_webhooks_in_quiet_hours_when_suppress", () => {
    const cfg = configure({
      quietHours: "22:00-08:00",
      quietHoursWebhooks: "suppress",
    });
    const { deps, webhooks, notify } = makeDeps();
    route(makeEvent(), cfg, deps, QUIET_NOW);
    expect(webhooks).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1); // desktop notify still fires
  });

  it("should_fire_webhooks_in_quiet_hours_when_fire_default", () => {
    const cfg = configure({ quietHours: "22:00-08:00" });
    const { deps, webhooks } = makeDeps();
    route(makeEvent(), cfg, deps, QUIET_NOW);
    expect(webhooks).toHaveBeenCalledTimes(1);
  });
});

describe("route: events.log", () => {
  it("should_append_a_capped_line_per_routed_event", () => {
    const cfg = configure({ events: { done: { mode: "silent" } } });
    const { deps } = makeDeps();
    for (let i = 0; i < 60; i += 1) {
      route(makeEvent(), cfg, deps, NOW);
    }
    const logPath = join(kelbrinHomeDir, "events.log");
    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(50);
    expect(lines[lines.length - 1]).toBe(
      "2026-07-11T12:00:00.000Z claude-code done my app",
    );
  });
});

describe("route: notifyArgv null", () => {
  it("should_skip_notify_when_platform_returns_null_argv", () => {
    const cfg = configure({ events: { done: { mode: "notify" } } });
    const { deps, notify } = makeDeps(fakePlatform({ notifyArgv: () => null }));
    route(makeEvent(), cfg, deps, NOW);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("route: precedence — quiet, mute, opt-in gate", () => {
  it("should_stay_silent_when_a_temporary_quiet_is_active", () => {
    const cfg = configure();
    setQuietUntil("indefinite");
    const mocks = makeDeps();
    const code = route(makeEvent(), cfg, mocks.deps, NOW);
    expect(code).toBe(0);
    expect(fired(mocks)).toBe(false);
  });

  it("should_stay_silent_when_the_project_is_muted", () => {
    const cfg = configure();
    touchMute(CWD);
    const mocks = makeDeps();
    route(makeEvent(), cfg, mocks.deps, NOW);
    expect(fired(mocks)).toBe(false);
  });

  it("should_fire_when_the_project_is_explicitly_enabled_under_opt_in", () => {
    const cfg = configure({ activation: "opt-in" });
    touchEnabled(CWD);
    const mocks = makeDeps();
    route(makeEvent(), cfg, mocks.deps, NOW);
    expect(fired(mocks)).toBe(true);
  });

  it("should_stay_silent_under_opt_in_when_the_project_is_not_enabled", () => {
    const cfg = configure({ activation: "opt-in" });
    const mocks = makeDeps();
    route(makeEvent(), cfg, mocks.deps, NOW);
    expect(fired(mocks)).toBe(false);
  });

  it("should_fire_by_default_under_activation_all", () => {
    const cfg = configure();
    expect(cfg.activation).toBe(DEFAULTS.activation);
    const mocks = makeDeps();
    route(makeEvent(), cfg, mocks.deps, NOW);
    expect(fired(mocks)).toBe(true);
  });

  it("should_let_mute_beat_enable", () => {
    const cfg = configure({ activation: "opt-in" });
    touchMute(CWD);
    touchEnabled(CWD);
    const mocks = makeDeps();
    route(makeEvent(), cfg, mocks.deps, NOW);
    expect(fired(mocks)).toBe(false);
  });
});
