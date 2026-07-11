import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";

import { DarwinPlatform } from "../../src/platform/darwin.ts";
import { LinuxPlatform } from "../../src/platform/linux.ts";
import { selectPlatform, spawnDetached } from "../../src/platform/index.ts";
import { Win32Platform } from "../../src/platform/win32.ts";

const SOUND_DIR = "/System/Library/Sounds";

/** Platform whose sound existence check always resolves to `answer`. */
function platform(fileExists: (path: string) => boolean): DarwinPlatform {
  return new DarwinPlatform(fileExists);
}

describe("DarwinPlatform.voiceArgv", () => {
  const engine = new DarwinPlatform();

  it("should_build_say_argv_with_explicit_voice_when_named", () => {
    expect(engine.voiceArgv("hello world", "Alex", 200)).toEqual([
      "say",
      "-v",
      "Alex",
      "-r",
      "200",
      "--",
      "hello world",
    ]);
  });

  it("should_place_double_dash_immediately_before_text", () => {
    const argv = engine.voiceArgv("hi there", "Alex", 200);
    expect(argv).not.toBeNull();
    const args = argv as string[];
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("hi there");
  });

  it("should_return_null_when_text_is_empty", () => {
    expect(engine.voiceArgv("", "Alex", 200)).toBeNull();
  });

  it("should_return_null_when_text_is_whitespace_only", () => {
    expect(engine.voiceArgv("   \t\n", "Alex", 200)).toBeNull();
  });

  it("should_cap_text_at_2000_chars", () => {
    const argv = engine.voiceArgv("a".repeat(10_000), "Alex", 200);
    const args = argv as string[];
    expect((args[args.length - 1] as string).length).toBe(2000);
  });

  it("should_omit_voice_flag_for_sentinels_and_null", () => {
    for (const sentinel of ["", "system", "default", "SYSTEM", "Default"]) {
      const argv = engine.voiceArgv("hi", sentinel, 200) as string[];
      expect(argv).not.toContain("-v");
      expect(argv[0]).toBe("say");
    }
    const nullArgv = engine.voiceArgv("hi", null, 200) as string[];
    expect(nullArgv).not.toContain("-v");
  });

  it("should_fall_back_to_default_rate_when_rate_is_nan", () => {
    const argv = engine.voiceArgv("hi", "Alex", Number.NaN) as string[];
    expect(argv[argv.indexOf("-r") + 1]).toBe("190");
  });

  it("should_truncate_fractional_rate_like_v1_int_cast", () => {
    const argv = engine.voiceArgv("hi", null, 199.9) as string[];
    expect(argv[argv.indexOf("-r") + 1]).toBe("199");
  });
});

describe("DarwinPlatform.notifyArgv", () => {
  const engine = new DarwinPlatform();

  it("should_build_osascript_display_notification_argv", () => {
    expect(engine.notifyArgv("hollr", "response ready")).toEqual([
      "osascript",
      "-e",
      'display notification "response ready" with title "hollr"',
    ]);
  });

  it("should_sanitize_quotes_and_strip_backslashes", () => {
    const argv = engine.notifyArgv('a"b\\c', 'x"y') as string[];
    const script = argv[2] as string;
    expect(script).not.toContain("\\");
    expect(script).toBe(`display notification "x'y" with title "a'bc"`);
  });

  it("should_cap_body_at_200_and_title_at_60", () => {
    const argv = engine.notifyArgv("t".repeat(100), "b".repeat(500)) as string[];
    const script = argv[2] as string;
    expect(script).toBe(
      `display notification "${"b".repeat(200)}" with title "${"t".repeat(60)}"`,
    );
  });
});

describe("DarwinPlatform.soundArgv", () => {
  it("should_resolve_afplay_argv_when_sound_file_exists", () => {
    expect(platform(() => true).soundArgv("Glass")).toEqual([
      "afplay",
      `${SOUND_DIR}/Glass.aiff`,
    ]);
  });

  it("should_return_null_when_sound_file_is_absent", () => {
    expect(platform(() => false).soundArgv("Glass")).toBeNull();
  });

  it("should_return_null_for_injection_attempt", () => {
    expect(platform(() => true).soundArgv("Glass; rm")).toBeNull();
  });

  it("should_return_null_for_path_traversal", () => {
    expect(platform(() => true).soundArgv("../../etc/passwd")).toBeNull();
  });

  it("should_return_null_for_empty_name", () => {
    expect(platform(() => true).soundArgv("")).toBeNull();
  });
});

describe("DarwinPlatform.enumerateVoicesArgv", () => {
  it("should_return_say_voice_list_argv", () => {
    expect(new DarwinPlatform().enumerateVoicesArgv()).toEqual([
      "say",
      "-v",
      "?",
    ]);
  });
});

describe("DarwinPlatform.parseVoicesOutput", () => {
  const engine = new DarwinPlatform();

  it("should_parse_names_including_multi_word_and_skip_junk", () => {
    const raw = [
      "Alex                en_US    # Most people recognize me by my voice.",
      "Bad News            en_US    # The entire universe is doomed.",
      "Grandma (Enhanced)  en_US    # Hello, my dear.",
      "",
      "garbage",
      "Zosia               pl_PL    # Cześć.",
    ].join("\n");
    expect(engine.parseVoicesOutput(raw)).toEqual([
      "Alex",
      "Bad News",
      "Grandma (Enhanced)",
      "Zosia",
    ]);
  });

  it("should_return_empty_array_for_blank_input", () => {
    expect(engine.parseVoicesOutput("\n\n   \n")).toEqual([]);
  });
});

describe("DarwinPlatform capabilities", () => {
  const engine = new DarwinPlatform();

  it("should_support_pause_resume", () => {
    expect(engine.canPauseResume).toBe(true);
  });

  it("should_require_say_and_osascript_and_mark_afplay_optional", () => {
    const bins = engine.requiredBinaries;
    const say = bins.find((b) => b.name === "say");
    const osascript = bins.find((b) => b.name === "osascript");
    const afplay = bins.find((b) => b.name === "afplay");
    expect(say?.optional).toBeFalsy();
    expect(osascript?.optional).toBeFalsy();
    expect(afplay?.optional).toBe(true);
  });
});

describe("spawnDetached", () => {
  const spawnMock = vi.mocked(spawn);
  let child: { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    child = { on: vi.fn(), unref: vi.fn() };
    child.on.mockReturnValue(child);
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
  });

  it("should_spawn_detached_with_ignored_stdio_and_unref", () => {
    spawnDetached(["say", "-v", "Alex", "--", "hi"]);
    expect(spawnMock).toHaveBeenCalledWith("say", ["-v", "Alex", "--", "hi"], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("should_attach_an_error_handler_to_swallow_spawn_failures", () => {
    spawnDetached(["afplay", "/System/Library/Sounds/Glass.aiff"]);
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("should_do_nothing_for_empty_argv", () => {
    spawnDetached([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("selectPlatform", () => {
  it("should_return_darwin_engine_for_darwin", () => {
    const engine = selectPlatform("darwin");
    expect(engine).toBeInstanceOf(DarwinPlatform);
    expect(engine.id).toBe("darwin");
  });

  it("should_return_linux_engine_for_linux", () => {
    const engine = selectPlatform("linux");
    expect(engine).toBeInstanceOf(LinuxPlatform);
    expect(engine.id).toBe("linux");
  });

  it("should_return_win32_engine_for_win32", () => {
    const engine = selectPlatform("win32");
    expect(engine).toBeInstanceOf(Win32Platform);
    expect(engine.id).toBe("win32");
  });

  it("should_throw_for_unsupported_platform", () => {
    expect(() => selectPlatform("freebsd")).toThrowError(
      /unsupported platform: freebsd/,
    );
  });
});
