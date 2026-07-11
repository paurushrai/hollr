import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Win32Platform } from "../../src/platform/win32.ts";

const WIN_SOUND_DIR = "C:\\Windows\\Media";
const INJECTION = "'); rm -rf (";

type Which = (bin: string) => string | null;

const alwaysPresent: Which = (bin) => `C:\\Windows\\System32\\${bin}.exe`;

/** Build a Win32Platform; `powershell` always resolves, existence overridable. */
function platform(fileExists: (path: string) => boolean = () => true): Win32Platform {
  return new Win32Platform(alwaysPresent, fileExists);
}

/** Extract every `ReadAllText('<path>')` argument from a PowerShell script. */
function readAllTextPaths(script: string): string[] {
  return [...script.matchAll(/ReadAllText\('([^']+)'\)/g)].map((m) => m[1] as string);
}

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  previousHome = process.env.HOLLR_HOME;
  home = mkdtempSync(join(tmpdir(), "hollr-win32-"));
  process.env.HOLLR_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOLLR_HOME;
  } else {
    process.env.HOLLR_HOME = previousHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("Win32Platform.voiceArgv", () => {
  it("should_build_powershell_argv_reading_text_from_tmp_file", () => {
    const argv = platform().voiceArgv("hello world", null, 190) as string[];
    expect(argv.slice(0, 3)).toEqual(["powershell", "-NoProfile", "-Command"]);
    const script = argv[3] as string;
    expect(script).toContain("Add-Type -AssemblyName System.Speech");
    expect(script).toContain("$s.Rate=0");
    const paths = readAllTextPaths(script);
    expect(paths).toHaveLength(1);
    expect(readFileSync(paths[0] as string, "utf8")).toBe("hello world");
    expect(script).toContain(`Remove-Item '${paths[0] as string}' -ErrorAction SilentlyContinue`);
  });

  it("should_keep_user_text_out_of_every_argv_element", () => {
    const argv = platform().voiceArgv(INJECTION, null, 190) as string[];
    for (const element of argv) {
      expect(element).not.toContain(INJECTION);
      expect(element).not.toContain("rm -rf");
    }
    const paths = readAllTextPaths(argv[3] as string);
    expect(readFileSync(paths[0] as string, "utf8")).toBe(INJECTION);
  });

  it("should_map_rate_anchors_and_clamp", () => {
    const rate = (wpm: number): string => {
      const script = (platform().voiceArgv("x", null, wpm) as string[])[3] as string;
      return (/\$s\.Rate=(-?\d+)/.exec(script) as RegExpExecArray)[1] as string;
    };
    expect(rate(150)).toBe("-3");
    expect(rate(190)).toBe("0");
    expect(rate(220)).toBe("3");
    expect(rate(Number.NaN)).toBe("0");
    expect(rate(10_000)).toBe("10");
    expect(rate(-10_000)).toBe("-10");
  });

  it("should_select_voice_only_when_name_is_alphanumeric_and_spaces", () => {
    const withVoice = platform().voiceArgv("x", "Microsoft David", 190) as string[];
    expect(withVoice[3] as string).toContain("$s.SelectVoice('Microsoft David')");

    const withBad = platform().voiceArgv("x", "David'); evil (", 190) as string[];
    expect(withBad[3] as string).not.toContain("SelectVoice");
    for (const element of withBad) {
      expect(element).not.toContain("evil");
    }
  });

  it("should_return_null_when_text_is_empty_or_whitespace", () => {
    expect(platform().voiceArgv("", null, 190)).toBeNull();
    expect(platform().voiceArgv("  \n", null, 190)).toBeNull();
  });
});

describe("Win32Platform.notifyArgv", () => {
  it("should_read_title_and_body_from_tmp_files", () => {
    const argv = platform().notifyArgv("hollr", "response ready") as string[];
    expect(argv.slice(0, 3)).toEqual(["powershell", "-NoProfile", "-Command"]);
    const script = argv[3] as string;
    expect(script).toContain("ToastNotificationManager");
    const paths = readAllTextPaths(script);
    expect(paths).toHaveLength(2);
    expect(readFileSync(paths[0] as string, "utf8")).toBe("hollr");
    expect(readFileSync(paths[1] as string, "utf8")).toBe("response ready");
    for (const path of paths) {
      expect(script).toContain(`Remove-Item '${path}' -ErrorAction SilentlyContinue`);
    }
  });

  it("should_keep_notify_body_out_of_every_argv_element", () => {
    const argv = platform().notifyArgv("hollr", INJECTION) as string[];
    for (const element of argv) {
      expect(element).not.toContain(INJECTION);
      expect(element).not.toContain("rm -rf");
    }
    const bodyPath = readAllTextPaths(argv[3] as string)[1] as string;
    expect(readFileSync(bodyPath, "utf8")).toBe(INJECTION);
  });
});

describe("Win32Platform.soundArgv", () => {
  it("should_build_soundplayer_argv_when_file_exists", () => {
    expect(platform().soundArgv("Windows Notify")).toEqual([
      "powershell",
      "-NoProfile",
      "-Command",
      `(New-Object Media.SoundPlayer '${WIN_SOUND_DIR}\\Windows Notify.wav').PlaySync()`,
    ]);
  });

  it("should_return_null_when_file_is_absent", () => {
    expect(platform(() => false).soundArgv("Windows Notify")).toBeNull();
  });

  it("should_reject_traversal_and_injection_names", () => {
    for (const bad of ["../etc", "a; rm", "a.b", ".hidden", "", "a\\b"]) {
      expect(platform().soundArgv(bad)).toBeNull();
    }
  });
});

describe("Win32Platform.enumerateVoicesArgv", () => {
  it("should_return_get_installed_voices_script", () => {
    const argv = platform().enumerateVoicesArgv() as string[];
    expect(argv.slice(0, 3)).toEqual(["powershell", "-NoProfile", "-Command"]);
    expect(argv[3] as string).toContain("GetInstalledVoices()");
    expect(argv[3] as string).toContain("VoiceInfo.Name");
  });
});

describe("Win32Platform.parseVoicesOutput", () => {
  const engine = platform();

  it("should_return_one_name_per_nonblank_line", () => {
    const raw = ["Microsoft David", "  Microsoft Zira  ", "", "   "].join("\n");
    expect(engine.parseVoicesOutput(raw)).toEqual(["Microsoft David", "Microsoft Zira"]);
  });

  it("should_return_empty_array_for_blank_input", () => {
    expect(engine.parseVoicesOutput("\n\n")).toEqual([]);
  });
});

describe("Win32Platform capabilities", () => {
  const engine = platform();

  it("should_not_support_pause_resume", () => {
    expect(engine.canPauseResume).toBe(false);
  });

  it("should_require_powershell", () => {
    expect(engine.requiredBinaries.some((b) => b.name === "powershell")).toBe(true);
  });

  it("should_report_win32_id", () => {
    expect(engine.id).toBe("win32");
  });
});
