import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { antigravity } from "../../src/adapters/antigravity.ts";
import { unwireFromLedger } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "antigravity");
const STOP_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "stop.json"), "utf8"),
) as Record<string, unknown>;

const KELBRIN_STOP_COMMAND =
  "kelbrin emit --agent antigravity --event done --payload-stdin; printf '{}'";
const LEDGER_KEY = "antigravity";

let tmpRoot: string;
let home: string;
let kelbrinHomeDir: string;
let prevKelbrinHome: string | undefined;

/** `which` fake that resolves nothing (agy not on PATH). */
const whichNone = (): string | null => null;
/** `which` fake resolving only `agy`. */
const whichAgy = (bin: string): string | null =>
  bin === "agy" ? "/Users/me/.local/bin/agy" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function hooksPath(): string {
  return join(home, ".gemini", "hooks.json");
}

function writeHooks(json: unknown): void {
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(hooksPath(), `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function readHooks(): Record<string, unknown> {
  return JSON.parse(readFileSync(hooksPath(), "utf8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-agy-"));
  home = join(tmpRoot, "home");
  kelbrinHomeDir = join(tmpRoot, ".config", "kelbrin");
  mkdirSync(home, { recursive: true });
  prevKelbrinHome = process.env.KELBRIN_HOME;
  process.env.KELBRIN_HOME = kelbrinHomeDir;
});

afterEach(() => {
  if (prevKelbrinHome === undefined) {
    delete process.env.KELBRIN_HOME;
  } else {
    process.env.KELBRIN_HOME = prevKelbrinHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("antigravity.normalize", () => {
  it("should_map_stop_payload_to_a_done_event", () => {
    const event = antigravity.normalize(STOP_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("antigravity");
    expect(event?.agentTitle).toBe("Antigravity");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.summary).toBe("");
    expect(event?.lastResponse).toBeNull();
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(antigravity.normalize("nope", "done")).toBeNull();
    expect(antigravity.normalize(null, "done")).toBeNull();
    expect(antigravity.normalize(42, "done")).toBeNull();
    expect(antigravity.normalize(["a"], "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_workspacePaths_is_missing", () => {
    const event = antigravity.normalize({ conversationId: "x" }, "done");
    expect(event?.cwd).toBe("");
    expect(event?.project).toBe("");
  });

  it("should_leave_cwd_empty_when_workspacePaths_is_empty_or_non_string", () => {
    expect(antigravity.normalize({ workspacePaths: [] }, "done")?.cwd).toBe("");
    expect(antigravity.normalize({ workspacePaths: [""] }, "done")?.cwd).toBe(
      "",
    );
    expect(antigravity.normalize({ workspacePaths: [5] }, "done")?.cwd).toBe("");
  });
});

describe("antigravity.readLastResponse", () => {
  it("should_always_resolve_null_announce_only", async () => {
    expect(await antigravity.readLastResponse(STOP_PAYLOAD)).toBeNull();
    expect(await antigravity.readLastResponse({})).toBeNull();
    expect(await antigravity.readLastResponse("nope")).toBeNull();
    expect(await antigravity.readLastResponse(null)).toBeNull();
  });
});

describe("antigravity.wire", () => {
  it("should_add_the_kelbrin_stop_hook_to_a_fresh_hooks_file", async () => {
    const result = await antigravity.wire(deps());
    expect(result.changed).toBe(true);
    expect(result.diff).toContain(KELBRIN_STOP_COMMAND);
    const kelbrin = readHooks().kelbrin as Record<string, unknown>;
    const stop = kelbrin.Stop as Array<{ type: string; command: string }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]?.type).toBe("command");
    expect(stop[0]?.command).toBe(KELBRIN_STOP_COMMAND);
  });

  it("should_wire_a_command_carrying_both_the_stdout_guard_and_payload_stdin", async () => {
    await antigravity.wire(deps());
    const kelbrin = readHooks().kelbrin as Record<string, unknown>;
    const stop = kelbrin.Stop as Array<{ command: string }>;
    const command = stop[0]?.command ?? "";
    expect(command).toBe(KELBRIN_STOP_COMMAND);
    expect(command).toContain("--payload-stdin");
    expect(command).toContain("printf '{}'");
  });

  it("should_preserve_an_existing_unrelated_named_entry", async () => {
    writeHooks({
      "lint-checker": {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "lint.sh" }],
          },
        ],
      },
    });
    await antigravity.wire(deps());
    const hooks = readHooks();
    expect(JSON.stringify(hooks["lint-checker"])).toContain("lint.sh");
    const kelbrin = hooks.kelbrin as Record<string, unknown>;
    expect(JSON.stringify(kelbrin.Stop)).toContain(KELBRIN_STOP_COMMAND);
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await antigravity.wire(deps());
    const second = await antigravity.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    const kelbrin = readHooks().kelbrin as Record<string, unknown>;
    expect(kelbrin.Stop as unknown[]).toHaveLength(1);
  });
});

describe("antigravity.unwire", () => {
  it("should_unwire_only_the_kelbrin_stop_hook_and_keep_a_foreign_entry", async () => {
    const testDeps = deps();
    await antigravity.wire(testDeps);
    const cfg = readHooks();
    (cfg.kelbrin as { Stop: unknown[] }).Stop.push({
      type: "command",
      command: "user-stop",
    });
    writeFileSync(hooksPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    await antigravity.unwire(testDeps);
    const kelbrin = readHooks().kelbrin as Record<string, unknown>;
    expect(kelbrin.Stop).toEqual([{ type: "command", command: "user-stop" }]);
  });

  it("should_preserve_an_unrelated_named_entry_on_unwire", async () => {
    writeHooks({
      "lint-checker": {
        PreToolUse: [{ hooks: [{ type: "command", command: "lint.sh" }] }],
      },
    });
    await antigravity.wire(deps());
    await antigravity.unwire(deps());
    const hooks = readHooks();
    expect(JSON.stringify(hooks["lint-checker"])).toContain("lint.sh");
    expect(hooks.kelbrin).toBeUndefined();
  });

  it("should_leave_the_hooks_file_without_the_kelbrin_entry_when_wiring_created_it", async () => {
    // unwireJsonFile is surgical: it rewrites the file's CURRENT content and
    // never tracks "did this file exist before" to delete it. A hooks.json
    // created solely by wire survives unwire as an empty JSON object.
    await antigravity.wire(deps());
    expect(existsSync(hooksPath())).toBe(true);
    await antigravity.unwire(deps());
    expect(existsSync(hooksPath())).toBe(true);
    expect(readHooks()).toEqual({});
  });

  afterEach(() => {
    unwireFromLedger(LEDGER_KEY);
  });
});

describe("antigravity hollr→kelbrin rename compat", () => {
  const LEGACY_STOP_COMMAND =
    "hollr emit --agent antigravity --event done --payload-stdin; printf '{}'";

  function writeLegacyHooks(): void {
    writeHooks({
      hollr: {
        Stop: [{ type: "command", command: LEGACY_STOP_COMMAND }],
      },
      "lint-checker": {
        PreToolUse: [{ hooks: [{ type: "command", command: "lint.sh" }] }],
      },
    });
  }

  afterEach(() => {
    unwireFromLedger(LEDGER_KEY);
  });

  it("should_replace_the_legacy_hollr_group_with_the_kelbrin_group_on_wire", async () => {
    writeLegacyHooks();
    await antigravity.wire(deps());
    const hooks = readHooks();
    expect(hooks.hollr).toBeUndefined();
    const kelbrin = hooks.kelbrin as Record<string, unknown>;
    expect(kelbrin.Stop).toEqual([
      { type: "command", command: KELBRIN_STOP_COMMAND },
    ]);
    expect(JSON.stringify(hooks["lint-checker"])).toContain("lint.sh");
  });

  it("should_remove_the_legacy_hollr_group_on_unwire_without_rewiring", async () => {
    writeLegacyHooks();
    await antigravity.unwire(deps());
    const hooks = readHooks();
    expect(hooks.hollr).toBeUndefined();
    expect(hooks.kelbrin).toBeUndefined();
    expect(JSON.stringify(hooks["lint-checker"])).toContain("lint.sh");
  });
});

describe("antigravity.detect", () => {
  it("should_report_installed_when_agy_is_on_path", async () => {
    const detection = await antigravity.detect(deps(whichAgy));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(hooksPath());
  });

  it("should_report_installed_when_the_dot_gemini_dir_exists", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const detection = await antigravity.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await antigravity.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });
});
