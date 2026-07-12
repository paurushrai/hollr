import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { amp } from "../../src/adapters/amp.ts";
import { listWiredKeys } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

/** `which` fake that resolves nothing (amp not on PATH). */
const whichNone = (): string | null => null;
/** `which` fake resolving only `amp`. */
const whichAmp = (bin: string): string | null =>
  bin === "amp" ? "/Users/me/.local/bin/amp" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

/** Amp's user settings dir: `~/.config/amp`. */
function configDir(): string {
  return join(home, ".config", "amp");
}

function settingsPath(): string {
  return join(configDir(), "settings.json");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-amp-"));
  home = join(tmpRoot, "home");
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  mkdirSync(home, { recursive: true });
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
});

describe("amp.capabilities", () => {
  it("should_announce_only_no_blocked_no_readaloud", () => {
    expect(amp.capabilities).toStrictEqual({
      done: true,
      blocked: false,
      readAloud: false,
      slashCommand: false,
      instructionInjection: false,
    });
  });
});

describe("amp.normalize", () => {
  it("should_map_payload_to_a_done_event", () => {
    const event = amp.normalize({ cwd: "/Users/me/dev/my-app" }, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("amp");
    expect(event?.agentTitle).toBe("Amp");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.summary).toBe("");
    expect(event?.lastResponse).toBeNull();
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_honor_the_event_hint", () => {
    expect(amp.normalize({ cwd: "/x" }, "blocked")?.event).toBe("blocked");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(amp.normalize("nope", "done")).toBeNull();
    expect(amp.normalize(null, "done")).toBeNull();
    expect(amp.normalize(42, "done")).toBeNull();
    expect(amp.normalize(["a"], "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_cwd_is_missing_or_non_string", () => {
    expect(amp.normalize({ threadId: "T-1" }, "done")?.cwd).toBe("");
    expect(amp.normalize({ cwd: "" }, "done")?.cwd).toBe("");
    expect(amp.normalize({ cwd: 5 }, "done")?.cwd).toBe("");
    expect(amp.normalize({ threadId: "T-1" }, "done")?.project).toBe("");
  });
});

describe("amp.readLastResponse", () => {
  it("should_always_resolve_null_transcripts_are_cloud_only", async () => {
    expect(await amp.readLastResponse({ cwd: "/x" })).toBeNull();
    expect(await amp.readLastResponse({})).toBeNull();
    expect(await amp.readLastResponse("nope")).toBeNull();
    expect(await amp.readLastResponse(null)).toBeNull();
  });
});

describe("amp.wire (instructions-only fallback)", () => {
  it("should_report_no_change_and_write_no_file", async () => {
    const result = await amp.wire(deps());
    expect(result.changed).toBe(false);
    expect(result.diff).toBe("");
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(configDir())).toBe(false);
    expect(listWiredKeys()).toStrictEqual([]);
  });

  it("should_return_warnings_explaining_the_announce_path", async () => {
    const result = await amp.wire(deps());
    expect(result.warnings.length).toBeGreaterThan(0);
    const text = result.warnings.join("\n");
    expect(text).toContain("amp.notifications");
    expect(text).toContain("hollr run");
  });
});

describe("amp.unwire", () => {
  it("should_be_a_safe_no_op", async () => {
    await expect(amp.unwire(deps())).resolves.toBeUndefined();
  });
});

describe("amp.detect", () => {
  it("should_report_installed_when_amp_is_on_path", async () => {
    const detection = await amp.detect(deps(whichAmp));
    expect(detection.installed).toBe(true);
  });

  it("should_report_installed_when_the_config_dir_exists", async () => {
    mkdirSync(configDir(), { recursive: true });
    const detection = await amp.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await amp.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });

  it("should_not_offer_instruction_injection_yet", () => {
    expect(amp.capabilities.instructionInjection).toBe(false);
    expect(amp.memoryPath).toBeUndefined();
  });
});
