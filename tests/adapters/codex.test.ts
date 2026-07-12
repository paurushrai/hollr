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

import { codex } from "../../src/adapters/codex.ts";
import { unwireFromLedger } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "codex");
const NOTIFY_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "notify.json"), "utf8"),
) as Record<string, unknown>;

const NOTIFY_LINE =
  'notify = ["hollr", "emit", "--agent", "codex", "--event", "done", "--payload-argv"]';
const BLOCKED_COMMAND =
  "hollr emit --agent codex --event blocked --payload-stdin";
const CONFIG_LEDGER_KEY = "codex:config";
const HOOKS_LEDGER_KEY = "codex:hooks";

/** A PermissionRequest hook payload (snake_case, stdin-delivered). */
const PERMISSION_PAYLOAD: Record<string, unknown> = {
  hook_event_name: "PermissionRequest",
  cwd: "/Users/me/dev/other-app",
  tool_name: "Bash",
  tool_input: { command: "rm -rf build" },
};

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

const whichNone = (): string | null => null;
const whichCodex = (bin: string): string | null =>
  bin === "codex" ? "/Users/me/.local/bin/codex" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function configPath(): string {
  return join(home, ".codex", "config.toml");
}

function hooksPath(): string {
  return join(home, ".codex", "hooks.json");
}

function writeConfig(text: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(configPath(), text, "utf8");
}

function readConfig(): string {
  return readFileSync(configPath(), "utf8");
}

function readHooks(): Record<string, unknown> {
  return JSON.parse(readFileSync(hooksPath(), "utf8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-codex-"));
  home = join(tmpRoot, "home");
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  mkdirSync(home, { recursive: true });
  prevHollrHome = process.env.HOLLR_HOME;
  process.env.HOLLR_HOME = hollrHomeDir;
});

afterEach(() => {
  unwireFromLedger(CONFIG_LEDGER_KEY);
  unwireFromLedger(HOOKS_LEDGER_KEY);
  if (prevHollrHome === undefined) {
    delete process.env.HOLLR_HOME;
  } else {
    process.env.HOLLR_HOME = prevHollrHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("codex.capabilities", () => {
  it("should_advertise_done_blocked_and_readaloud", () => {
    expect(codex.capabilities).toEqual({
      done: true,
      blocked: true,
      readAloud: true,
      slashCommand: false,
      instructionInjection: true,
    });
  });
});

describe("codex.normalize", () => {
  it("should_map_the_notify_payload_to_a_done_event", () => {
    const event = codex.normalize(NOTIFY_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("codex");
    expect(event?.agentTitle).toBe("Codex");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.summary).toBe("");
    expect(event?.lastResponse).toBeNull();
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_map_a_permission_request_payload_to_a_blocked_event", () => {
    const event = codex.normalize(PERMISSION_PAYLOAD, "blocked");
    expect(event?.event).toBe("blocked");
    expect(event?.cwd).toBe("/Users/me/dev/other-app");
    expect(event?.project).toBe("other app");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(codex.normalize("nope", "done")).toBeNull();
    expect(codex.normalize(null, "done")).toBeNull();
    expect(codex.normalize(42, "done")).toBeNull();
    expect(codex.normalize(["a"], "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_cwd_is_missing_or_non_string", () => {
    expect(codex.normalize({ "turn-id": "1" }, "done")?.cwd).toBe("");
    expect(codex.normalize({ cwd: 5 }, "done")?.cwd).toBe("");
  });
});

describe("codex.readLastResponse", () => {
  it("should_return_the_last_assistant_message_directly", async () => {
    expect(await codex.readLastResponse(NOTIFY_PAYLOAD)).toBe(
      "Rename complete and verified `cargo build` succeeds.",
    );
  });

  it("should_return_null_when_the_field_is_missing_or_not_a_string", async () => {
    expect(await codex.readLastResponse({})).toBeNull();
    expect(
      await codex.readLastResponse({ "last-assistant-message": 42 }),
    ).toBeNull();
  });

  it("should_return_null_when_raw_is_not_an_object", async () => {
    expect(await codex.readLastResponse("nope")).toBeNull();
    expect(await codex.readLastResponse(null)).toBeNull();
  });
});

describe("codex.wire config.toml notify", () => {
  it("should_add_the_notify_line_to_a_fresh_config", async () => {
    const result = await codex.wire(deps());
    expect(result.changed).toBe(true);
    expect(result.diff).toContain(NOTIFY_LINE);
    expect(readConfig()).toContain(NOTIFY_LINE);
  });

  it("should_preserve_unrelated_keys_and_insert_notify_above_tables", async () => {
    writeConfig('model = "gpt-5"\n\n[profile.ci]\napproval_policy = "never"\n');
    await codex.wire(deps());
    const text = readConfig();
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('approval_policy = "never"');
    // notify must sit before the first table header to remain top-level.
    expect(text.indexOf(NOTIFY_LINE)).toBeLessThan(text.indexOf("[profile.ci]"));
  });

  it("should_append_notify_when_config_has_only_top_level_keys", async () => {
    writeConfig('model = "gpt-5"\napproval_policy = "on-request"\n');
    await codex.wire(deps());
    const text = readConfig();
    expect(text).toContain('model = "gpt-5"');
    expect(text.trimEnd().endsWith(NOTIFY_LINE)).toBe(true);
  });

  it("should_replace_a_differing_notify_line_in_place", async () => {
    writeConfig('notify = ["old-notifier"]\nmodel = "gpt-5"\n');
    await codex.wire(deps());
    const text = readConfig();
    expect(text).not.toContain("old-notifier");
    expect(text).toContain(NOTIFY_LINE);
    expect(text).toContain('model = "gpt-5"');
  });

  it("should_replace_a_multi_line_notify_array_leaving_valid_toml", async () => {
    writeConfig('notify = [\n  "old-notifier"\n]\nmodel = "gpt-5"\n');
    await codex.wire(deps());
    const text = readConfig();
    // The old multi-line array must be fully removed — no orphans.
    expect(text).not.toContain("old-notifier");
    expect(text).toContain(NOTIFY_LINE);
    expect(text).toContain('model = "gpt-5"');
    // Exactly one `notify =` and one `]` (the one inside the hollr line).
    expect(text.split("notify =").length).toBe(2);
    expect((text.match(/\]/g) ?? []).length).toBe(1);
    // No dangling continuation line or stray closing bracket survives.
    const lines = text.split("\n");
    expect(lines).not.toContain('  "old-notifier"');
    expect(lines.some((line) => line.trim() === "]")).toBe(false);
  });

  it("should_be_idempotent_after_replacing_a_multi_line_array", async () => {
    writeConfig('notify = [\n  "old-notifier"\n]\nmodel = "gpt-5"\n');
    await codex.wire(deps());
    const second = await codex.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
  });

  it("should_not_replace_a_notify_inside_a_table_section", async () => {
    writeConfig('model = "gpt-5"\n\n[profile.ci]\nnotify = ["scoped-notifier"]\n');
    await codex.wire(deps());
    const text = readConfig();
    // A notify nested in a table is left untouched...
    expect(text).toContain('notify = ["scoped-notifier"]');
    // ...and hollr's top-level notify is inserted before the section.
    expect(text).toContain(NOTIFY_LINE);
    expect(text.indexOf(NOTIFY_LINE)).toBeLessThan(text.indexOf("[profile.ci]"));
    expect(text.indexOf(NOTIFY_LINE)).toBeLessThan(text.indexOf("scoped-notifier"));
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await codex.wire(deps());
    const second = await codex.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    expect(readConfig().split("notify =").length).toBe(2);
  });

  it("should_warn_about_the_hook_trust_step", async () => {
    const result = await codex.wire(deps());
    expect(result.warnings.join(" ")).toMatch(/trust/i);
  });
});

describe("codex.wire hooks.json blocked", () => {
  it("should_add_a_permission_request_hook_with_a_catch_all_matcher", async () => {
    await codex.wire(deps());
    const hooks = readHooks().hooks as Record<string, unknown>;
    const entries = hooks.PermissionRequest as Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe(".*");
    expect(entries[0]?.hooks[0]?.type).toBe("command");
    expect(entries[0]?.hooks[0]?.command).toBe(BLOCKED_COMMAND);
  });

  it("should_preserve_an_unrelated_hook_event", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      hooksPath(),
      `${JSON.stringify(
        { hooks: { Stop: [{ matcher: ".*", hooks: [{ type: "command", command: "log.sh" }] }] } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await codex.wire(deps());
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.Stop)).toContain("log.sh");
    expect(JSON.stringify(hooks.PermissionRequest)).toContain(BLOCKED_COMMAND);
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await codex.wire(deps());
    await codex.wire(deps());
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(hooks.PermissionRequest as unknown[]).toHaveLength(1);
  });
});

describe("codex.unwire", () => {
  it("should_restore_config_byte_identically_and_clear_hollr_hooks", async () => {
    writeConfig('model = "gpt-5"\n');
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(hooksPath(), `${JSON.stringify({ hooks: {} }, null, 2)}\n`, "utf8");
    const configBefore = readConfig();
    await codex.wire(deps());
    expect(readConfig()).not.toBe(configBefore);
    await codex.unwire(deps());
    expect(readConfig()).toBe(configBefore);
    expect(JSON.stringify(readHooks())).not.toContain(BLOCKED_COMMAND);
  });

  it("should_leave_existing_but_hollr_free_files_when_nothing_preexisted", async () => {
    await codex.wire(deps());
    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(hooksPath())).toBe(true);
    await codex.unwire(deps());
    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(hooksPath())).toBe(true);
    expect(readConfig()).not.toContain("notify");
    expect(JSON.stringify(readHooks())).not.toContain(BLOCKED_COMMAND);
  });

  it("should_unwire_notify_line_but_keep_other_config_toml_keys", async () => {
    const testDeps = deps();
    await codex.wire(testDeps);
    const cfgPath = configPath();
    // user adds their own key after wiring:
    writeFileSync(cfgPath, `${readFileSync(cfgPath, "utf8")}model = "gpt-5"\n`);
    await codex.unwire(testDeps);
    const out = readFileSync(cfgPath, "utf8");
    expect(out).not.toContain("notify");
    expect(out).toContain('model = "gpt-5"');
  });

  it("should_unwire_only_hollr_permission_hook_and_keep_foreign", async () => {
    const testDeps = deps();
    await codex.wire(testDeps);
    const cfg = readHooks();
    const hooks = cfg.hooks as { PermissionRequest: unknown[] };
    hooks.PermissionRequest.push({
      matcher: ".*",
      hooks: [{ type: "command", command: "user-cmd" }],
    });
    writeFileSync(hooksPath(), JSON.stringify(cfg, null, 2));
    await codex.unwire(testDeps);
    const out = readHooks();
    const entries = (out.hooks as Record<string, unknown[]> | undefined)?.PermissionRequest ?? [];
    const cmds = (entries as Array<{ hooks: { command: string }[] }>).flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(cmds).toEqual(["user-cmd"]);
  });
});

describe("codex.wire/unwire notify archive & restore", () => {
  const USER_NOTIFY = 'notify = ["my", "cmd"]';

  function notifyBackupPath(): string {
    return join(hollrHomeDir, "codex-notify.bak");
  }

  it("should_archive_a_pre_existing_user_notify_on_wire", async () => {
    writeConfig(`${USER_NOTIFY}\n`);
    await codex.wire(deps());
    expect(existsSync(notifyBackupPath())).toBe(true);
    expect(readFileSync(notifyBackupPath(), "utf8")).toBe(USER_NOTIFY);
    expect(readConfig()).toContain(NOTIFY_LINE);
  });

  it("should_restore_the_archived_notify_byte_for_byte_on_unwire", async () => {
    writeConfig(`${USER_NOTIFY}\n`);
    const testDeps = deps();
    await codex.wire(testDeps);
    await codex.unwire(testDeps);
    expect(readConfig()).toContain(USER_NOTIFY);
    expect(readConfig()).not.toContain(NOTIFY_LINE);
    expect(existsSync(notifyBackupPath())).toBe(false);
  });

  it("should_remove_notify_entirely_when_no_pre_existing_notify_existed", async () => {
    const testDeps = deps();
    await codex.wire(testDeps);
    expect(existsSync(notifyBackupPath())).toBe(false);
    await codex.unwire(testDeps);
    expect(readConfig()).not.toContain("notify");
    expect(existsSync(notifyBackupPath())).toBe(false);
  });

  it("should_not_archive_when_the_existing_notify_is_already_hollrs_own", async () => {
    const testDeps = deps();
    await codex.wire(testDeps);
    await codex.wire(testDeps);
    expect(existsSync(notifyBackupPath())).toBe(false);
  });
});

describe("codex.detect", () => {
  it("should_report_installed_when_codex_is_on_path", async () => {
    const detection = await codex.detect(deps(whichCodex));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(configPath());
  });

  it("should_report_installed_when_the_dot_codex_dir_exists", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const detection = await codex.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await codex.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });

  it("should_expose_global_AGENTS_md_as_its_memory_path", () => {
    expect(codex.capabilities.instructionInjection).toBe(true);
    expect(codex.memoryPath?.({ home: "/home/u", which: () => null })).toBe(
      "/home/u/.codex/AGENTS.md",
    );
  });
});
