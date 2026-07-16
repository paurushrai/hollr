import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/index.ts")>();
  return { ...actual, spawnDetached: vi.fn() };
});

import { DarwinPlatform } from "../../src/platform/darwin.ts";
import { spawnDetached } from "../../src/platform/index.ts";
import { HELPER_PATH, speakSequenced } from "../../src/platform/sequencer.ts";

interface HelperPayload {
  soundArgv: string[] | null;
  voiceArgv: string[] | null;
  pidPath: string;
}

const detachedMock = vi.mocked(spawnDetached);

let tmpRoot: string;
let kelbrinHomeDir: string;
let prevKelbrinHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-seq-"));
  kelbrinHomeDir = join(tmpRoot, ".config", "kelbrin");
  prevKelbrinHome = process.env.KELBRIN_HOME;
  process.env.KELBRIN_HOME = kelbrinHomeDir;
  detachedMock.mockReset();
});

afterEach(() => {
  if (prevKelbrinHome === undefined) {
    delete process.env.KELBRIN_HOME;
  } else {
    process.env.KELBRIN_HOME = prevKelbrinHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function lastPayload(): HelperPayload {
  const call = detachedMock.mock.calls[0];
  expect(call).toBeDefined();
  const argv = (call as unknown[])[0] as string[];
  return JSON.parse(argv[2] as string) as HelperPayload;
}

describe("speakSequenced", () => {
  it("should_invoke_helper_with_node_and_exported_helper_path", () => {
    speakSequenced({
      text: "all done",
      voice: "Alex",
      rateWpm: 200,
      sound: "Glass",
      platform: new DarwinPlatform(() => true),
    });
    expect(detachedMock).toHaveBeenCalledTimes(1);
    const argv = detachedMock.mock.calls[0]?.[0] as string[];
    expect(argv[0]).toBe("node");
    expect(argv[1]).toBe(HELPER_PATH);
    expect(typeof argv[2]).toBe("string");
  });

  it("should_round_trip_both_argvs_and_pidpath_in_payload", () => {
    speakSequenced({
      text: "all done",
      voice: "Alex",
      rateWpm: 200,
      sound: "Glass",
      platform: new DarwinPlatform(() => true),
    });
    const payload = lastPayload();
    expect(payload.soundArgv).toEqual(["afplay", "/System/Library/Sounds/Glass.aiff"]);
    expect(payload.voiceArgv).toEqual(["say", "-v", "Alex", "-r", "200", "--", "all done"]);
    expect(payload.pidPath).toBe(join(kelbrinHomeDir, "reading.pid"));
  });

  it("should_pass_null_sound_argv_when_sound_is_null", () => {
    speakSequenced({
      text: "hi",
      voice: null,
      rateWpm: 190,
      sound: null,
      platform: new DarwinPlatform(() => true),
    });
    const payload = lastPayload();
    expect(payload.soundArgv).toBeNull();
    expect(payload.voiceArgv).not.toBeNull();
  });

  it("should_pass_null_voice_argv_when_text_is_empty_but_still_play_sound", () => {
    speakSequenced({
      text: "   ",
      voice: null,
      rateWpm: 190,
      sound: "Glass",
      platform: new DarwinPlatform(() => true),
    });
    const payload = lastPayload();
    expect(payload.voiceArgv).toBeNull();
    expect(payload.soundArgv).toEqual(["afplay", "/System/Library/Sounds/Glass.aiff"]);
  });

  it("should_be_a_noop_when_both_argvs_are_null", () => {
    speakSequenced({
      text: "",
      voice: null,
      rateWpm: 190,
      sound: null,
      platform: new DarwinPlatform(() => true),
    });
    expect(detachedMock).not.toHaveBeenCalled();
  });

  it("should_resolve_helper_path_ending_in_the_helper_script", () => {
    expect(HELPER_PATH.endsWith("scripts/helper/play-then-say.mjs")).toBe(true);
  });
});
