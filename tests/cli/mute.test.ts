import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeCwd, isMuted } from "../../src/core/config.ts";
import { runMute, setProjectState } from "../../src/cli/mute.ts";

const CWD = "/Users/me/dev/my-app";

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-mute-"));
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  prevHollrHome = process.env.HOLLR_HOME;
  process.env.HOLLR_HOME = hollrHomeDir;
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
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

function flagPath(cwd: string): string {
  return join(hollrHomeDir, "projects", `${encodeCwd(cwd)}.muted`);
}

function lastLine(): string {
  const calls = stdout.mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

describe("runMute", () => {
  it("should_create_flag_and_print_muted_when_on", () => {
    const code = runMute(["on"], CWD);
    expect(code).toBe(0);
    expect(isMuted(CWD)).toBe(true);
    expect(existsSync(flagPath(CWD))).toBe(true);
    expect(lastLine()).toContain("hollr: off for my app");
  });

  it("should_create_projects_dir_when_absent_on", () => {
    expect(existsSync(join(hollrHomeDir, "projects"))).toBe(false);
    runMute(["on"], CWD);
    expect(existsSync(flagPath(CWD))).toBe(true);
  });

  it("should_remove_flag_and_print_unmuted_when_off", () => {
    runMute(["on"], CWD);
    const code = runMute(["off"], CWD);
    expect(code).toBe(0);
    expect(isMuted(CWD)).toBe(false);
    expect(lastLine()).toContain("hollr: on for my app");
  });

  it("should_not_throw_when_off_and_flag_absent", () => {
    let code: number | undefined;
    expect(() => {
      code = runMute(["off"], CWD);
    }).not.toThrow();
    expect(code).toBe(0);
    expect(isMuted(CWD)).toBe(false);
    expect(lastLine()).toContain("hollr: on for");
  });

  it("should_toggle_on_then_off_when_bare", () => {
    runMute([], CWD);
    expect(isMuted(CWD)).toBe(true);
    expect(lastLine()).toContain("hollr: off for");

    runMute([], CWD);
    expect(isMuted(CWD)).toBe(false);
    expect(lastLine()).toContain("hollr: on for");
  });
});

const ON_OFF_CWD = "/tmp/proj";

function projectFlagPath(cwd: string, suffix: string): string {
  return join(hollrHomeDir, "projects", `${encodeCwd(cwd)}${suffix}`);
}

describe("setProjectState", () => {
  it("on creates .enabled and removes .muted", () => {
    setProjectState(false, ON_OFF_CWD);
    setProjectState(true, ON_OFF_CWD);
    expect(existsSync(projectFlagPath(ON_OFF_CWD, ".enabled"))).toBe(true);
    expect(existsSync(projectFlagPath(ON_OFF_CWD, ".muted"))).toBe(false);
  });

  it("off creates .muted and removes .enabled", () => {
    setProjectState(true, ON_OFF_CWD);
    setProjectState(false, ON_OFF_CWD);
    expect(existsSync(projectFlagPath(ON_OFF_CWD, ".muted"))).toBe(true);
    expect(existsSync(projectFlagPath(ON_OFF_CWD, ".enabled"))).toBe(false);
  });

  it("is idempotent", () => {
    setProjectState(true, ON_OFF_CWD);
    expect(setProjectState(true, ON_OFF_CWD)).toBe(0);
    expect(existsSync(projectFlagPath(ON_OFF_CWD, ".enabled"))).toBe(true);
  });
});
