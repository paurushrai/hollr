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

import { cursor } from "../../src/adapters/cursor.ts";
import { unwireFromLedger } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "cursor");
const STOP_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "stop.json"), "utf8"),
) as Record<string, unknown>;
const BEFORESHELL_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "beforeshell.json"), "utf8"),
) as Record<string, unknown>;

const STOP_COMMAND = "kelbrin emit --agent cursor --event done --payload-stdin";
const LEDGER_KEY = "cursor";

let tmpRoot: string;
let home: string;
let kelbrinHomeDir: string;
let prevKelbrinHome: string | undefined;

/** `which` fake that resolves nothing (cursor-agent not on PATH). */
const whichNone = (): string | null => null;
/** `which` fake resolving only `cursor-agent`. */
const whichCursor = (bin: string): string | null =>
  bin === "cursor-agent" ? "/Users/me/.local/bin/cursor-agent" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function hooksPath(): string {
  return join(home, ".cursor", "hooks.json");
}

function writeHooks(json: unknown): void {
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(hooksPath(), `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function readHooks(): Record<string, unknown> {
  return JSON.parse(readFileSync(hooksPath(), "utf8")) as Record<
    string,
    unknown
  >;
}

function hookCommands(event: string): string[] {
  const hooks = readHooks().hooks as Record<string, unknown>;
  const list = hooks[event] as Array<{ command?: unknown }>;
  return list.map((entry) => String(entry.command));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-cursor-"));
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

describe("cursor.capabilities & tagline", () => {
  it("should_declare_done_only_no_blocked_no_readaloud", () => {
    expect(cursor.capabilities).toEqual({
      done: true,
      blocked: false,
      readAloud: false,
      slashCommand: false,
      instructionInjection: false,
    });
  });

  it("should_describe_done_via_stop_hook_in_the_tagline", () => {
    expect(cursor.tagline.toLowerCase()).toMatch(/done/);
  });
});

describe("cursor.normalize", () => {
  it("should_map_stop_payload_to_a_done_event_using_workspace_roots", () => {
    const event = cursor.normalize(STOP_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("cursor");
    expect(event?.agentTitle).toBe("Cursor");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.summary).toBe("");
    expect(event?.lastResponse).toBeNull();
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_map_beforeshell_payload_to_a_blocked_event_using_cwd", () => {
    const event = cursor.normalize(BEFORESHELL_PAYLOAD, "blocked");
    expect(event?.event).toBe("blocked");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(cursor.normalize("nope", "done")).toBeNull();
    expect(cursor.normalize(null, "done")).toBeNull();
    expect(cursor.normalize(42, "done")).toBeNull();
    expect(cursor.normalize(["a"], "done")).toBeNull();
  });

  it("should_fall_back_to_workspace_roots_when_cwd_is_empty", () => {
    const event = cursor.normalize(
      { cwd: "", workspace_roots: ["/tmp/proj"] },
      "blocked",
    );
    expect(event?.cwd).toBe("/tmp/proj");
  });

  it("should_leave_cwd_empty_when_neither_cwd_nor_workspace_roots_present", () => {
    expect(cursor.normalize({ conversation_id: "x" }, "done")?.cwd).toBe("");
    expect(cursor.normalize({ workspace_roots: [] }, "done")?.cwd).toBe("");
    expect(cursor.normalize({ workspace_roots: [5] }, "done")?.cwd).toBe("");
  });
});

describe("cursor.readLastResponse", () => {
  it("should_always_resolve_null_no_readaloud_from_hooks", async () => {
    expect(await cursor.readLastResponse(STOP_PAYLOAD)).toBeNull();
    expect(await cursor.readLastResponse({})).toBeNull();
    expect(await cursor.readLastResponse("nope")).toBeNull();
    expect(await cursor.readLastResponse(null)).toBeNull();
  });
});

describe("cursor.wire", () => {
  it("should_add_only_the_stop_hook_to_a_fresh_file", async () => {
    const result = await cursor.wire(deps());
    expect(result.changed).toBe(true);
    expect(result.diff).toContain(STOP_COMMAND);
    expect(readHooks().version).toBe(1);
    expect(hookCommands("stop")).toEqual([STOP_COMMAND]);
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(hooks.beforeShellExecution).toBeUndefined();
  });

  it("should_preserve_an_existing_unrelated_hook_entry_without_wiring_blocked", async () => {
    writeHooks({
      version: 1,
      hooks: {
        beforeShellExecution: [
          { type: "command", command: "./approve.sh", matcher: "curl" },
        ],
      },
    });
    await cursor.wire(deps());
    const commands = hookCommands("beforeShellExecution");
    expect(commands).toEqual(["./approve.sh"]);
    expect(hookCommands("stop")).toEqual([STOP_COMMAND]);
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await cursor.wire(deps());
    const second = await cursor.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    expect(hookCommands("stop")).toEqual([STOP_COMMAND]);
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(hooks.beforeShellExecution).toBeUndefined();
  });
});

describe("cursor.unwire", () => {
  it("should_unwire_only_kelbrin_stop_hook_and_keep_foreign", async () => {
    const testDeps = deps();
    await cursor.wire(testDeps);
    const cfg = readHooks();
    (cfg.hooks as { stop: unknown[] }).stop.push({
      type: "command",
      command: "user-stop",
    });
    writeFileSync(hooksPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    await cursor.unwire(testDeps);
    expect(hookCommands("stop")).toEqual(["user-stop"]);
  });

  it("should_preserve_an_unrelated_hook_event_on_unwire", async () => {
    writeHooks({
      version: 1,
      hooks: {
        beforeShellExecution: [{ type: "command", command: "./approve.sh" }],
      },
    });
    await cursor.wire(deps());
    await cursor.unwire(deps());
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.beforeShellExecution)).toContain(
      "./approve.sh",
    );
    expect(hooks.stop).toBeUndefined();
  });

  it("should_leave_the_hooks_file_without_a_stop_array_when_wiring_created_it", async () => {
    // unwireJsonFile is surgical: it rewrites the file's CURRENT content and
    // never tracks "did this file exist before" to delete it. A hooks.json
    // created solely by wire survives unwire, minus the (now-empty) stop entry.
    await cursor.wire(deps());
    expect(existsSync(hooksPath())).toBe(true);
    await cursor.unwire(deps());
    expect(existsSync(hooksPath())).toBe(true);
    const out = readHooks();
    expect(out.hooks).toBeUndefined();
    expect(out.version).toBe(1);
  });

  afterEach(() => {
    unwireFromLedger(LEDGER_KEY);
  });
});

describe("cursor hollr→kelbrin rename compat", () => {
  const LEGACY_STOP = "hollr emit --agent cursor --event done --payload-stdin";

  afterEach(() => {
    unwireFromLedger(LEDGER_KEY);
  });

  it("should_unwire_legacy_hollr_stop_entry_and_keep_a_foreign_entry", async () => {
    writeHooks({
      version: 1,
      hooks: {
        stop: [
          { type: "command", command: LEGACY_STOP },
          { type: "command", command: "user-stop" },
        ],
      },
    });
    await cursor.unwire(deps());
    const raw = readFileSync(hooksPath(), "utf8");
    expect(raw).not.toContain("hollr emit");
    expect(hookCommands("stop")).toEqual(["user-stop"]);
  });

  it("should_replace_the_legacy_hollr_stop_entry_on_wire_without_duplicating", async () => {
    writeHooks({
      version: 1,
      hooks: {
        stop: [{ type: "command", command: LEGACY_STOP }],
      },
    });
    await cursor.wire(deps());
    const raw = readFileSync(hooksPath(), "utf8");
    expect(raw).not.toContain("hollr emit");
    expect(hookCommands("stop")).toEqual([STOP_COMMAND]);
  });
});

describe("cursor.detect", () => {
  it("should_report_installed_when_cursor_agent_is_on_path", async () => {
    const detection = await cursor.detect(deps(whichCursor));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(hooksPath());
  });

  it("should_report_installed_when_the_dot_cursor_dir_exists", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const detection = await cursor.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await cursor.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });
});
