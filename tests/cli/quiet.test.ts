import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quietUntilPath } from "../../src/core/config.ts";
import { parseDuration, runQuiet } from "../../src/cli/quiet.ts";

const NOW = new Date("2026-07-12T12:00:00Z");

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-quiet-"));
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
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

describe("parseDuration", () => {
  it("parses seconds, minutes, hours", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });
  it("rejects garbage with null (no silent fallback)", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });
});

describe("runQuiet", () => {
  it("bare quiet writes an indefinite marker", () => {
    expect(runQuiet([], NOW)).toBe(0);
    expect(readFileSync(quietUntilPath(), "utf8").trim()).toBe("indefinite");
  });
  it("quiet <duration> writes now + duration as epoch ms", () => {
    runQuiet(["30m"], NOW);
    expect(readFileSync(quietUntilPath(), "utf8").trim()).toBe(String(NOW.getTime() + 1_800_000));
  });
  it("quiet off removes the marker", () => {
    runQuiet([], NOW);
    runQuiet(["off"], NOW);
    expect(existsSync(quietUntilPath())).toBe(false);
  });
  it("throws a plain message on an unparseable duration", () => {
    expect(() => runQuiet(["soon"], NOW)).toThrow(/soon/);
  });
});
