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

import { unwireFromLedger } from "../../src/adapters/diffwire.ts";
import { gemini } from "../../src/adapters/gemini.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "gemini");
const AFTER_AGENT_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "afteragent.json"), "utf8"),
) as Record<string, unknown>;
const NOTIFICATION_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "notification.json"), "utf8"),
) as Record<string, unknown>;

const DONE_COMMAND = "hollr emit --agent gemini --event done --payload-stdin";
const BLOCKED_COMMAND =
  "hollr emit --agent gemini --event blocked --payload-stdin";
const SETTINGS_LEDGER_KEY = "gemini:settings";
const COMMAND_LEDGER_KEY = "gemini:command";

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

const whichNone = (): string | null => null;
const whichGemini = (bin: string): string | null =>
  bin === "gemini" ? "/Users/me/.local/bin/gemini" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function settingsPath(): string {
  return join(home, ".gemini", "settings.json");
}

function commandPath(): string {
  return join(home, ".gemini", "commands", "hollr.toml");
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<
    string,
    unknown
  >;
}

function hookEntries(event: string): Array<{
  hooks: Array<{ type: string; command: string }>;
}> {
  const hooks = readSettings().hooks as Record<string, unknown>;
  return hooks[event] as Array<{
    hooks: Array<{ type: string; command: string }>;
  }>;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-gemini-"));
  home = join(tmpRoot, "home");
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  mkdirSync(home, { recursive: true });
  prevHollrHome = process.env.HOLLR_HOME;
  process.env.HOLLR_HOME = hollrHomeDir;
});

afterEach(() => {
  unwireFromLedger(SETTINGS_LEDGER_KEY);
  unwireFromLedger(COMMAND_LEDGER_KEY);
  if (prevHollrHome === undefined) {
    delete process.env.HOLLR_HOME;
  } else {
    process.env.HOLLR_HOME = prevHollrHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("gemini.capabilities", () => {
  it("should_advertise_done_blocked_readaloud_and_slash_command", () => {
    expect(gemini.capabilities).toEqual({
      done: true,
      blocked: true,
      readAloud: true,
      slashCommand: true,
      instructionInjection: true,
    });
  });
});

describe("gemini.normalize", () => {
  it("should_map_the_after_agent_payload_to_a_done_event", () => {
    const event = gemini.normalize(AFTER_AGENT_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("gemini");
    expect(event?.agentTitle).toBe("Gemini");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.lastResponse).toBeNull();
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_map_the_notification_payload_to_a_blocked_event", () => {
    const event = gemini.normalize(NOTIFICATION_PAYLOAD, "blocked");
    expect(event?.event).toBe("blocked");
    expect(event?.cwd).toBe("/Users/me/dev/other-app");
    expect(event?.project).toBe("other app");
    expect(event?.summary).toBe(
      "Gemini needs your permission to run a shell command.",
    );
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(gemini.normalize("nope", "done")).toBeNull();
    expect(gemini.normalize(null, "done")).toBeNull();
    expect(gemini.normalize(42, "done")).toBeNull();
    expect(gemini.normalize(["a"], "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_cwd_is_missing_or_non_string", () => {
    expect(gemini.normalize({ session_id: "1" }, "done")?.cwd).toBe("");
    expect(gemini.normalize({ cwd: 5 }, "done")?.cwd).toBe("");
  });
});

describe("gemini.readLastResponse", () => {
  it("should_return_the_prompt_response_directly", async () => {
    expect(await gemini.readLastResponse(AFTER_AGENT_PAYLOAD)).toBe(
      "Renamed `foo` to `bar` in 4 files and verified the build passes.",
    );
  });

  it("should_return_null_when_the_field_is_missing_or_not_a_string", async () => {
    expect(await gemini.readLastResponse({})).toBeNull();
    expect(await gemini.readLastResponse({ prompt_response: 42 })).toBeNull();
    expect(await gemini.readLastResponse(NOTIFICATION_PAYLOAD)).toBeNull();
  });

  it("should_return_null_when_raw_is_not_an_object", async () => {
    expect(await gemini.readLastResponse("nope")).toBeNull();
    expect(await gemini.readLastResponse(null)).toBeNull();
  });
});

describe("gemini.wire settings.json hooks", () => {
  it("should_add_after_agent_and_notification_hooks_to_a_fresh_config", async () => {
    const result = await gemini.wire(deps());
    expect(result.changed).toBe(true);
    const afterAgent = hookEntries("AfterAgent");
    const notification = hookEntries("Notification");
    expect(afterAgent[0]?.hooks[0]?.type).toBe("command");
    expect(afterAgent[0]?.hooks[0]?.command).toBe(DONE_COMMAND);
    expect(notification[0]?.hooks[0]?.command).toBe(BLOCKED_COMMAND);
  });

  it("should_preserve_an_unrelated_hook_event", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      settingsPath(),
      `${JSON.stringify(
        {
          theme: "dark",
          hooks: {
            BeforeTool: [
              { matcher: "read_.*", hooks: [{ type: "command", command: "audit.sh" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await gemini.wire(deps());
    const settings = readSettings();
    expect(settings.theme).toBe("dark");
    const hooks = settings.hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.BeforeTool)).toContain("audit.sh");
    expect(JSON.stringify(hooks.AfterAgent)).toContain(DONE_COMMAND);
    expect(JSON.stringify(hooks.Notification)).toContain(BLOCKED_COMMAND);
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await gemini.wire(deps());
    const second = await gemini.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    expect(hookEntries("AfterAgent")).toHaveLength(1);
    expect(hookEntries("Notification")).toHaveLength(1);
  });
});

describe("gemini.wire slash command file", () => {
  it("should_write_the_hollr_toml_custom_command", async () => {
    await gemini.wire(deps());
    expect(existsSync(commandPath())).toBe(true);
    const toml = readFileSync(commandPath(), "utf8");
    expect(toml).toContain("description =");
    expect(toml).toContain("prompt =");
    expect(toml).toContain("!{hollr {{args}}}");
  });

  it("should_be_idempotent_for_the_command_file", async () => {
    await gemini.wire(deps());
    const first = readFileSync(commandPath(), "utf8");
    const second = await gemini.wire(deps());
    expect(second.changed).toBe(false);
    expect(readFileSync(commandPath(), "utf8")).toBe(first);
  });
});

describe("gemini.unwire", () => {
  it("should_restore_settings_and_delete_the_command_file", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      settingsPath(),
      `${JSON.stringify({ theme: "dark" }, null, 2)}\n`,
      "utf8",
    );
    const settingsBefore = readFileSync(settingsPath(), "utf8");
    await gemini.wire(deps());
    expect(readFileSync(settingsPath(), "utf8")).not.toBe(settingsBefore);
    expect(existsSync(commandPath())).toBe(true);
    await gemini.unwire(deps());
    expect(readFileSync(settingsPath(), "utf8")).toBe(settingsBefore);
    expect(existsSync(commandPath())).toBe(false);
  });

  it("should_delete_settings_that_did_not_exist_before_wiring", async () => {
    await gemini.wire(deps());
    expect(existsSync(settingsPath())).toBe(true);
    await gemini.unwire(deps());
    expect(existsSync(settingsPath())).toBe(false);
  });
});

describe("gemini.detect", () => {
  it("should_report_installed_when_gemini_is_on_path", async () => {
    const detection = await gemini.detect(deps(whichGemini));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(settingsPath());
  });

  it("should_not_report_installed_on_a_bare_dot_gemini_dir_without_the_binary", async () => {
    // ~/.gemini is shared with Antigravity; its bare presence must NOT
    // false-positive gemini-cli when the gemini binary is absent.
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "hooks.json"),
      `${JSON.stringify({ hollr: {} }, null, 2)}\n`,
      "utf8",
    );
    const detection = await gemini.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await gemini.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });

  it("should_expose_global_GEMINI_md_as_its_memory_path", () => {
    expect(gemini.capabilities.instructionInjection).toBe(true);
    expect(gemini.memoryPath?.({ home: "/home/u", which: () => null })).toBe(
      "/home/u/.gemini/GEMINI.md",
    );
  });
});
