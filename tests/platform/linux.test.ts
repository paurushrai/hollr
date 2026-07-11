import { describe, expect, it } from "vitest";

import { LinuxPlatform } from "../../src/platform/linux.ts";
import { rateToSpd } from "../../src/platform/rate.ts";

const LINUX_SOUND_DIR = "/usr/share/sounds/freedesktop/stereo";

type Which = (bin: string) => string | null;

/** `which` fake resolving only the named binaries to a fake path. */
function whichWith(...present: string[]): Which {
  return (bin) => (present.includes(bin) ? `/usr/bin/${bin}` : null);
}

/** Build a LinuxPlatform with injected `which` and `fileExists` fakes. */
function platform(
  present: string[],
  fileExists: (path: string) => boolean = () => true,
): LinuxPlatform {
  return new LinuxPlatform(whichWith(...present), fileExists);
}

describe("rateToSpd", () => {
  it("should_map_anchor_rates_linearly", () => {
    expect(rateToSpd(150)).toBe("-40");
    expect(rateToSpd(190)).toBe("0");
    expect(rateToSpd(220)).toBe("30");
  });

  it("should_return_zero_string_when_rate_is_nan", () => {
    expect(rateToSpd(Number.NaN)).toBe("0");
  });

  it("should_clamp_to_spd_bounds", () => {
    expect(rateToSpd(10_000)).toBe("100");
    expect(rateToSpd(-10_000)).toBe("-100");
  });
});

describe("LinuxPlatform.voiceArgv", () => {
  it("should_prefer_spd_say_with_voice_when_available", () => {
    expect(platform(["spd-say"]).voiceArgv("hello world", "en", 220)).toEqual([
      "spd-say",
      "-y",
      "en",
      "-r",
      "30",
      "--wait",
      "hello world",
    ]);
  });

  it("should_omit_voice_flag_when_voice_is_null_or_empty", () => {
    for (const voice of [null, ""]) {
      const argv = platform(["spd-say"]).voiceArgv("hi", voice, 190) as string[];
      expect(argv).not.toContain("-y");
      expect(argv).toEqual(["spd-say", "-r", "0", "--wait", "hi"]);
    }
  });

  it("should_fall_back_to_espeak_ng_when_spd_say_missing", () => {
    expect(platform(["espeak-ng"]).voiceArgv("hi", "en", 199.9)).toEqual([
      "espeak-ng",
      "-v",
      "en",
      "-s",
      "199",
      "--",
      "hi",
    ]);
  });

  it("should_fall_back_to_espeak_when_only_espeak_present", () => {
    expect(platform(["espeak"]).voiceArgv("hi", null, Number.NaN)).toEqual([
      "espeak",
      "-s",
      "190",
      "--",
      "hi",
    ]);
  });

  it("should_return_null_when_no_tts_binary_is_available", () => {
    expect(platform([]).voiceArgv("hi", "en", 190)).toBeNull();
  });

  it("should_return_null_when_text_is_empty_or_whitespace", () => {
    expect(platform(["spd-say"]).voiceArgv("", "en", 190)).toBeNull();
    expect(platform(["spd-say"]).voiceArgv("  \t\n", "en", 190)).toBeNull();
  });

  it("should_cap_speech_text_at_2000_chars", () => {
    const argv = platform(["spd-say"]).voiceArgv("a".repeat(9000), null, 190) as string[];
    expect((argv[argv.length - 1] as string).length).toBe(2000);
  });
});

describe("LinuxPlatform.notifyArgv", () => {
  const engine = platform([]);

  it("should_build_notify_send_argv", () => {
    expect(engine.notifyArgv("hollr", "response ready")).toEqual([
      "notify-send",
      "--app-name=hollr",
      "hollr",
      "response ready",
    ]);
  });

  it("should_cap_title_at_60_and_body_at_200", () => {
    const argv = engine.notifyArgv("t".repeat(100), "b".repeat(500)) as string[];
    expect((argv[2] as string).length).toBe(60);
    expect((argv[3] as string).length).toBe(200);
  });
});

describe("LinuxPlatform.soundArgv", () => {
  it("should_resolve_paplay_when_present_and_file_exists", () => {
    expect(platform(["paplay"]).soundArgv("message-new-instant")).toEqual([
      "paplay",
      `${LINUX_SOUND_DIR}/message-new-instant.oga`,
    ]);
  });

  it("should_fall_back_to_aplay_when_paplay_missing", () => {
    expect(platform(["aplay"]).soundArgv("dialog-warning")).toEqual([
      "aplay",
      `${LINUX_SOUND_DIR}/dialog-warning.oga`,
    ]);
  });

  it("should_return_null_when_no_player_is_available", () => {
    expect(platform([]).soundArgv("dialog-warning")).toBeNull();
  });

  it("should_return_null_when_sound_file_is_absent", () => {
    expect(platform(["paplay"], () => false).soundArgv("dialog-warning")).toBeNull();
  });

  it("should_reject_path_traversal_and_injection_and_dotted_names", () => {
    for (const bad of ["../etc", "a; rm", "a.b", ".hidden", "", "/abs", "a/b"]) {
      expect(platform(["paplay"]).soundArgv(bad)).toBeNull();
    }
  });

  it("should_accept_hyphen_underscore_space_and_digit_names", () => {
    expect(platform(["paplay"]).soundArgv("Bell Sound_2-x")).not.toBeNull();
  });
});

describe("LinuxPlatform.enumerateVoicesArgv", () => {
  it("should_prefer_spd_say_list", () => {
    expect(platform(["spd-say"]).enumerateVoicesArgv()).toEqual(["spd-say", "-L"]);
  });

  it("should_fall_back_to_espeak_ng_voices", () => {
    expect(platform(["espeak-ng"]).enumerateVoicesArgv()).toEqual([
      "espeak-ng",
      "--voices",
    ]);
  });

  it("should_return_null_when_no_engine_is_available", () => {
    expect(platform([]).enumerateVoicesArgv()).toBeNull();
  });
});

describe("LinuxPlatform.parseVoicesOutput", () => {
  const engine = platform([]);

  it("should_parse_spd_say_first_column_and_skip_header", () => {
    const raw = [
      "NAME                LANGUAGE   VARIANT",
      "Afrikaans           af         none",
      "",
      "Aragonese           an         none",
    ].join("\n");
    expect(engine.parseVoicesOutput(raw)).toEqual(["Afrikaans", "Aragonese"]);
  });

  it("should_parse_espeak_ng_name_column_when_pty_header", () => {
    const raw = [
      "Pty Language       Age/Gender VoiceName          File",
      " 5  af              --/M      Afrikaans          gmw/af",
      " 5  am              --/M      Amharic            sem/am",
      " 5  bad",
    ].join("\n");
    expect(engine.parseVoicesOutput(raw)).toEqual(["Afrikaans", "Amharic"]);
  });

  it("should_return_empty_array_for_blank_input", () => {
    expect(engine.parseVoicesOutput("\n\n   \n")).toEqual([]);
  });
});

describe("LinuxPlatform capabilities", () => {
  const engine = platform([]);

  it("should_support_pause_resume", () => {
    expect(engine.canPauseResume).toBe(true);
  });

  it("should_declare_required_binaries", () => {
    const names = engine.requiredBinaries.map((b) => b.name);
    expect(names).toContain("spd-say");
    expect(names).toContain("notify-send");
    const paplay = engine.requiredBinaries.find((b) => b.name === "paplay");
    expect(paplay?.optional).toBe(true);
  });

  it("should_report_linux_id", () => {
    expect(engine.id).toBe("linux");
  });
});
