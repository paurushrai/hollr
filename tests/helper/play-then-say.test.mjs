import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { run } from "../../scripts/helper/play-then-say.mjs";

const VOICE_PID = 4242;
const PID_PATH = "/tmp/kelbrin/reading.pid";
const SOUND_ARGV = ["afplay", "/System/Library/Sounds/Glass.aiff"];
const VOICE_ARGV = ["say", "-v", "Alex", "-r", "200", "--", "hello"];

function fakeChild(pid = VOICE_PID) {
  return { pid, on: vi.fn() };
}

function closeCallback(child) {
  const call = child.on.mock.calls.find(([event]) => event === "close");
  return call ? call[1] : undefined;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(unlinkSync).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("play-then-say helper", () => {
  it("should_play_sound_synchronously_before_spawning_voice", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    run({ soundArgv: SOUND_ARGV, voiceArgv: VOICE_ARGV, pidPath: PID_PATH });

    expect(spawnSync).toHaveBeenCalledWith("afplay", ["/System/Library/Sounds/Glass.aiff"]);
    expect(spawn).toHaveBeenCalledWith("say", ["-v", "Alex", "-r", "200", "--", "hello"]);
    const soundOrder = vi.mocked(spawnSync).mock.invocationCallOrder[0];
    const voiceOrder = vi.mocked(spawn).mock.invocationCallOrder[0];
    expect(soundOrder).toBeLessThan(voiceOrder);
  });

  it("should_write_pid_before_awaiting_exit_and_not_clear_yet", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    run({ soundArgv: null, voiceArgv: VOICE_ARGV, pidPath: PID_PATH });

    expect(writeFileSync).toHaveBeenCalledWith(PID_PATH, String(VOICE_PID), "utf8");
    expect(closeCallback(child)).toBeTypeOf("function");
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it("should_clear_pidfile_on_exit_when_it_still_owns_the_pid", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(readFileSync).mockReturnValue(String(VOICE_PID));

    run({ soundArgv: null, voiceArgv: VOICE_ARGV, pidPath: PID_PATH });
    closeCallback(child)();

    expect(unlinkSync).toHaveBeenCalledWith(PID_PATH);
  });

  it("should_not_clear_pidfile_on_exit_when_a_newer_reading_took_over", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(readFileSync).mockReturnValue("9999");

    run({ soundArgv: null, voiceArgv: VOICE_ARGV, pidPath: PID_PATH });
    closeCallback(child)();

    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it("should_skip_sound_when_sound_argv_is_null", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    run({ soundArgv: null, voiceArgv: VOICE_ARGV, pidPath: PID_PATH });

    expect(spawnSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("should_skip_voice_when_voice_argv_is_null", () => {
    run({ soundArgv: SOUND_ARGV, voiceArgv: null, pidPath: PID_PATH });

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("should_do_nothing_when_both_argvs_are_null", () => {
    run({ soundArgv: null, voiceArgv: null, pidPath: PID_PATH });

    expect(spawnSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("should_never_throw_when_a_subprocess_call_fails", () => {
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("afplay missing");
    });

    expect(() =>
      run({ soundArgv: SOUND_ARGV, voiceArgv: VOICE_ARGV, pidPath: PID_PATH }),
    ).not.toThrow();
  });
});
