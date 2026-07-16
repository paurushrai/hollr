import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force the router to throw so we exercise two invariants in one file:
//  - `emit` must STILL exit 0 (runEmitSafe swallows the throw), and
//  - a non-emit failure must surface (mute below does not touch the router).
vi.mock("../src/core/router.ts", () => ({
  route: (): number => {
    throw new Error("router boom");
  },
}));

import { main, run } from "../src/index.ts";

let tmpRoot: string;
let prevKelbrinHome: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-dispatch-"));
  prevKelbrinHome = process.env.KELBRIN_HOME;
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
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

function stderrText(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

/** Point KELBRIN_HOME at a regular file so `mkdirSync("<file>/projects")` fails
 *  with ENOTDIR — deterministic, no injected fs needed. */
function useUnwritableHome(): void {
  const blocker = join(tmpRoot, "home-is-a-file");
  writeFileSync(blocker, "");
  process.env.KELBRIN_HOME = blocker;
}

describe("dispatch: non-emit failures surface (not silent exit 0)", () => {
  it("should_exit_nonzero_and_write_stderr_when_mute_write_fails", async () => {
    useUnwritableHome();

    const code = await main(["mute", "on"]);

    expect(code).not.toBe(0);
    expect(code).toBe(1);
    expect(stderrText().length).toBeGreaterThan(0);
    expect(stderrText()).toContain("kelbrin:");
    expect(stderrText()).toContain("mute flag");
  });

  it("should_reject_out_of_run_rather_than_swallow_mute_write_failure", async () => {
    useUnwritableHome();
    await expect(run(["mute", "on"])).rejects.toThrow(/mute flag/);
  });
});

describe("dispatch: emit still exits 0 when it throws internally", () => {
  beforeEach(() => {
    // Fresh, empty (unmuted) home so the router IS reached — and it throws.
    process.env.KELBRIN_HOME = join(tmpRoot, ".config", "kelbrin");
  });

  it("should_exit_0_from_run_when_route_throws", async () => {
    expect(await run(["emit", "--agent", "x", "--event", "done"])).toBe(0);
  });

  it("should_exit_0_through_main_when_route_throws", async () => {
    expect(await main(["emit", "--agent", "x", "--event", "done"])).toBe(0);
  });
});
