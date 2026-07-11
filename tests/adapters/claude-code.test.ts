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

import { claudeCode } from "../../src/adapters/claude-code.ts";
import { unwireFromLedger } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "claude-code");
const STOP_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "stop.json"), "utf8"),
) as Record<string, unknown>;
const NOTIFICATION_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "notification.json"), "utf8"),
) as Record<string, unknown>;
const TRANSCRIPT_FIXTURE = join(FIXTURES, "transcript.jsonl");

const STOP_COMMAND =
  "hollr emit --agent claude-code --event done --payload-stdin";
const NOTIFICATION_COMMAND =
  "hollr emit --agent claude-code --event blocked --payload-stdin";
const LEDGER_KEY = "claude-code:settings";

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

/** `which` fake that resolves nothing (claude not on PATH). */
const whichNone = (): string | null => null;
/** `which` fake resolving only `claude`. */
const whichClaude = (bin: string): string | null =>
  bin === "claude" ? "/usr/bin/claude" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function settingsPath(): string {
  return join(home, ".claude", "settings.json");
}

function writeSettings(json: unknown): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-cc-"));
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

describe("claudeCode.normalize", () => {
  it("should_map_stop_payload_to_a_done_event", () => {
    const event = claudeCode.normalize(STOP_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("claude-code");
    expect(event?.agentTitle).toBe("Claude Code");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_map_notification_payload_to_a_blocked_event_with_message_summary", () => {
    const event = claudeCode.normalize(NOTIFICATION_PAYLOAD, "blocked");
    expect(event?.event).toBe("blocked");
    expect(event?.summary).toBe("Claude needs your permission to use Bash");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(claudeCode.normalize("nope", "done")).toBeNull();
    expect(claudeCode.normalize(null, "done")).toBeNull();
    expect(claudeCode.normalize(42, "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_payload_omits_it", () => {
    const event = claudeCode.normalize({ hook_event_name: "Stop" }, "done");
    expect(event?.cwd).toBe("");
  });
});

describe("claudeCode.readLastResponse", () => {
  it("should_join_multiple_text_blocks_of_the_last_assistant_message", async () => {
    const text = await claudeCode.readLastResponse({
      transcript_path: TRANSCRIPT_FIXTURE,
    });
    expect(text).toBe("All done. Tests pass.");
  });

  it("should_skip_a_malformed_json_line", async () => {
    const path = join(tmpRoot, "malformed.jsonl");
    writeFileSync(
      path,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"good"}]}}\n' +
        "{broken json\n",
      "utf8",
    );
    expect(await claudeCode.readLastResponse({ transcript_path: path })).toBe(
      "good",
    );
  });

  it("should_return_null_for_a_missing_file", async () => {
    expect(
      await claudeCode.readLastResponse({
        transcript_path: "/nonexistent/x.jsonl",
      }),
    ).toBeNull();
  });

  it("should_ignore_non_assistant_lines", async () => {
    const path = join(tmpRoot, "user-only.jsonl");
    writeFileSync(path, '{"type":"user","message":{"content":[]}}\n', "utf8");
    expect(
      await claudeCode.readLastResponse({ transcript_path: path }),
    ).toBeNull();
  });

  it("should_read_only_the_last_2mb_tail_and_find_the_final_message", async () => {
    const path = join(tmpRoot, "big.jsonl");
    const filler = `${"x".repeat(2_100_000)}\n`;
    const line =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"tail wins"}]}}\n';
    // The filler exceeds 2 MB, so the head (including any earlier line) is
    // never read; only the tail line survives.
    writeFileSync(path, filler + line, "utf8");
    expect(await claudeCode.readLastResponse({ transcript_path: path })).toBe(
      "tail wins",
    );
  });

  it("should_return_null_when_raw_lacks_a_transcript_path", async () => {
    expect(await claudeCode.readLastResponse({})).toBeNull();
    expect(await claudeCode.readLastResponse("nope")).toBeNull();
  });
});

describe("claudeCode.wire", () => {
  it("should_append_both_stop_and_notification_hooks", async () => {
    const result = await claudeCode.wire(deps());
    expect(result.changed).toBe(true);
    expect(result.diff).toContain(STOP_COMMAND);
    expect(result.diff).toContain(NOTIFICATION_COMMAND);
    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.Stop)).toContain(STOP_COMMAND);
    expect(JSON.stringify(hooks.Notification)).toContain(NOTIFICATION_COMMAND);
  });

  it("should_preserve_an_existing_unrelated_hook", async () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] },
        ],
      },
    });
    await claudeCode.wire(deps());
    const hooks = readSettings().hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.PreToolUse)).toContain("audit.sh");
    expect(JSON.stringify(hooks.Stop)).toContain(STOP_COMMAND);
    expect(JSON.stringify(hooks.Notification)).toContain(NOTIFICATION_COMMAND);
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await claudeCode.wire(deps());
    const second = await claudeCode.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    const hooks = readSettings().hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    // No duplicate hook entry appended.
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Notification).toHaveLength(1);
  });

  it("should_warn_when_a_legacy_python_hook_is_present", async () => {
    writeSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "python announce-done.py" }] },
        ],
      },
    });
    const result = await claudeCode.wire(deps());
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("announce-done.py");
  });
});

describe("claudeCode.unwire", () => {
  it("should_restore_the_prior_settings_byte_identically", async () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "audit.sh" }] }],
      },
    });
    const original = readFileSync(settingsPath(), "utf8");
    await claudeCode.wire(deps());
    expect(readFileSync(settingsPath(), "utf8")).not.toBe(original);
    await claudeCode.unwire(deps());
    expect(readFileSync(settingsPath(), "utf8")).toBe(original);
  });

  it("should_delete_settings_that_did_not_exist_before_wiring", async () => {
    await claudeCode.wire(deps());
    expect(existsSync(settingsPath())).toBe(true);
    await claudeCode.unwire(deps());
    expect(existsSync(settingsPath())).toBe(false);
  });

  afterEach(() => {
    unwireFromLedger(LEDGER_KEY);
  });
});

describe("claudeCode.detect", () => {
  it("should_report_installed_when_the_dot_claude_dir_exists", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const detection = await claudeCode.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(settingsPath());
  });

  it("should_report_installed_when_claude_is_on_path", async () => {
    const detection = await claudeCode.detect(deps(whichClaude));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await claudeCode.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });

  it("should_surface_legacy_marker_as_degraded", async () => {
    writeSettings({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "hollr_hook.py" }] }],
      },
    });
    const detection = await claudeCode.detect(deps(whichNone));
    expect(detection.degraded).toContain("hollr_hook.py");
  });

  it("should_never_throw_on_a_malformed_settings_file", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), "{ not json", "utf8");
    await expect(claudeCode.detect(deps(whichNone))).resolves.toBeDefined();
  });
});
