import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMuted } from "../src/core/config.ts";
import { run } from "../src/index.ts";

const BANNER = "hollr 0.2.0";

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-cli-"));
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

function captureStdout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stdout, "write").mockReturnValue(true);
}

function captureStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

describe("run: version", () => {
  it("should_print_banner_and_return_0_for_version_flag", async () => {
    const out = captureStdout();
    expect(await run(["--version"])).toBe(0);
    expect(stdoutText(out)).toContain(BANNER);
  });

  it("should_print_banner_for_short_version_flag", async () => {
    const out = captureStdout();
    expect(await run(["-v"])).toBe(0);
    expect(stdoutText(out)).toContain(BANNER);
  });
});

describe("run: unknown / absent command", () => {
  it("should_print_usage_to_stderr_and_return_2_for_unknown", async () => {
    const err = captureStderr();
    const code = await run(["bogus"]);
    expect(code).toBe(2);
    expect(stdoutText(err).toLowerCase()).toContain("usage");
  });

  it("should_print_usage_and_return_2_when_no_command", async () => {
    const err = captureStderr();
    expect(await run([])).toBe(2);
    expect(stdoutText(err).toLowerCase()).toContain("usage");
  });
});

describe("run: control commands", () => {
  it.each(["pause", "resume", "stop"])(
    "should_print_a_hollr_line_and_return_0_for_%s",
    async (cmd) => {
      const out = captureStdout();
      const code = await run([cmd]);
      expect(code).toBe(0);
      expect(stdoutText(out)).toContain("hollr:");
    },
  );
});

describe("run: doctor", () => {
  it("should_print_node_check_and_return_0_or_1", async () => {
    const out = captureStdout();
    const code = await run(["doctor"]);
    expect([0, 1]).toContain(code);
    expect(stdoutText(out)).toContain("Node.js");
  });
});

describe("run: mute dispatch", () => {
  it("should_toggle_the_mute_flag_for_the_cwd", async () => {
    captureStdout();
    const code = await run(["mute", "on"]);
    expect(code).toBe(0);
    expect(isMuted(process.cwd())).toBe(true);
  });
});

describe("run: emit never breaks the agent", () => {
  it("should_return_0_for_a_muted_project_without_spawning", async () => {
    captureStdout();
    // Mute the cwd so route returns early (no real speak/notify spawn).
    await run(["mute", "on"]);
    const code = await run(["emit", "--agent", "claude-code", "--event", "done"]);
    expect(code).toBe(0);
  });

  it("should_return_0_even_when_event_is_garbage", async () => {
    captureStdout();
    await run(["mute", "on"]);
    const code = await run(["emit", "--agent", "x", "--event", "garbage"]);
    expect(code).toBe(0);
  });
});
