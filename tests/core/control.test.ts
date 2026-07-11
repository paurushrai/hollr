import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pauseReading, resumeReading, stopReading } from "../../src/core/control.ts";
import type { Platform } from "../../src/platform/index.ts";
import { selectPlatform } from "../../src/platform/index.ts";

interface KillCall {
  pid: number;
  signal: NodeJS.Signals | number | undefined;
}

const RUNNING_PID = 4242;
const DARWIN: Platform = selectPlatform("darwin");
const WIN32: Platform = selectPlatform("win32");

let tmpRoot: string;
let pidPath: string;
let killCalls: KillCall[];

function recordingKill(): (pid: number, signal?: NodeJS.Signals | number) => void {
  return (pid, signal) => {
    killCalls.push({ pid, signal });
  };
}

function throwingKill(code: string): (pid: number, signal?: NodeJS.Signals | number) => void {
  return (pid, signal) => {
    killCalls.push({ pid, signal });
    const error = new Error("kill failed") as Error & { code: string };
    error.code = code;
    throw error;
  };
}

function writePidfile(raw: string): void {
  writeFileSync(pidPath, raw, "utf8");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-ctl-"));
  pidPath = join(tmpRoot, "reading.pid");
  killCalls = [];
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("pauseReading", () => {
  it("should_signal_sigstop_and_report_paused_when_a_reader_is_tracked", () => {
    writePidfile(String(RUNNING_PID));
    const message = pauseReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: reading paused");
    expect(killCalls).toEqual([{ pid: RUNNING_PID, signal: "SIGSTOP" }]);
    expect(existsSync(pidPath)).toBe(true);
  });

  it("should_report_nothing_when_pidfile_is_missing", () => {
    const message = pauseReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(killCalls).toEqual([]);
  });

  it("should_report_nothing_when_pidfile_is_garbage", () => {
    writePidfile("not-a-pid");
    const message = pauseReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(killCalls).toEqual([]);
  });

  it("should_report_nothing_when_pidfile_is_empty", () => {
    writePidfile("   ");
    const message = pauseReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(killCalls).toEqual([]);
  });

  it("should_clear_pidfile_and_report_nothing_when_pid_is_stale_esrch", () => {
    writePidfile(String(RUNNING_PID));
    const message = pauseReading({ platform: DARWIN, kill: throwingKill("ESRCH"), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should_clear_pidfile_and_report_nothing_when_kill_denied_eperm", () => {
    writePidfile(String(RUNNING_PID));
    const message = pauseReading({ platform: DARWIN, kill: throwingKill("EPERM"), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should_report_unsupported_without_signaling_on_win32", () => {
    writePidfile(String(RUNNING_PID));
    const message = pauseReading({ platform: WIN32, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: pause is not supported on Windows — use hollr stop");
    expect(killCalls).toEqual([]);
    expect(existsSync(pidPath)).toBe(true);
  });
});

describe("resumeReading", () => {
  it("should_signal_sigcont_and_report_resumed_when_a_reader_is_tracked", () => {
    writePidfile(String(RUNNING_PID));
    const message = resumeReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: reading resumed");
    expect(killCalls).toEqual([{ pid: RUNNING_PID, signal: "SIGCONT" }]);
  });

  it("should_report_nothing_when_pidfile_is_missing", () => {
    const message = resumeReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(killCalls).toEqual([]);
  });

  it("should_report_unsupported_without_signaling_on_win32", () => {
    writePidfile(String(RUNNING_PID));
    const message = resumeReading({ platform: WIN32, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: pause is not supported on Windows — use hollr stop");
    expect(killCalls).toEqual([]);
  });
});

describe("stopReading", () => {
  it("should_signal_sigterm_clear_pidfile_and_report_stopped_on_posix", () => {
    writePidfile(String(RUNNING_PID));
    const message = stopReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: reading stopped");
    expect(killCalls).toEqual([{ pid: RUNNING_PID, signal: "SIGTERM" }]);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should_kill_with_default_signal_on_win32", () => {
    writePidfile(String(RUNNING_PID));
    const message = stopReading({ platform: WIN32, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: reading stopped");
    expect(killCalls).toEqual([{ pid: RUNNING_PID, signal: undefined }]);
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should_report_nothing_when_pidfile_is_missing", () => {
    const message = stopReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(killCalls).toEqual([]);
  });

  it("should_clear_pidfile_and_report_nothing_when_pid_is_stale", () => {
    writePidfile(String(RUNNING_PID));
    const message = stopReading({ platform: DARWIN, kill: throwingKill("ESRCH"), pidPath });
    expect(message).toBe("hollr: nothing is being read");
    expect(existsSync(pidPath)).toBe(false);
  });

  it("should_round_trip_a_valid_pid_from_the_pidfile", () => {
    writePidfile(`  ${RUNNING_PID}\n`);
    stopReading({ platform: DARWIN, kill: recordingKill(), pidPath });
    expect(killCalls[0]?.pid).toBe(RUNNING_PID);
  });
});

describe("control public entry points", () => {
  it("should_be_callable_with_no_arguments", () => {
    const home = mkdtempSync(join(tmpdir(), "hollr-ctl-home-"));
    const prev = process.env.HOLLR_HOME;
    process.env.HOLLR_HOME = home;
    try {
      // No pidfile exists under this fresh HOLLR_HOME, so every op is a safe no-op.
      expect(pauseReading()).toBe(
        selectPlatform().canPauseResume
          ? "hollr: nothing is being read"
          : "hollr: pause is not supported on Windows — use hollr stop",
      );
      expect(stopReading()).toBe("hollr: nothing is being read");
      expect(readFileSync).toBeDefined();
    } finally {
      if (prev === undefined) {
        delete process.env.HOLLR_HOME;
      } else {
        process.env.HOLLR_HOME = prev;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
