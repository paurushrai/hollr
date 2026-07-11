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

import { copilot } from "../../src/adapters/copilot.ts";
import { unwireFromLedger } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "copilot");
const AGENT_STOP_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "agent-stop.json"), "utf8"),
) as Record<string, unknown>;
const NOTIFICATION_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "notification.json"), "utf8"),
) as Record<string, unknown>;
const EVENTS_FIXTURE = join(FIXTURES, "events.jsonl");

const DONE_COMMAND = "hollr emit --agent copilot --event done --payload-stdin";
const BLOCKED_COMMAND =
  "hollr emit --agent copilot --event blocked --payload-stdin";
const LEDGER_KEY = "copilot:hooks";

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

const whichNone = (): string | null => null;
const whichCopilot = (bin: string): string | null =>
  bin === "copilot" ? "/usr/bin/copilot" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function hooksPath(): string {
  return join(home, ".copilot", "hooks", "hollr.json");
}

function writeHooks(json: unknown): void {
  mkdirSync(join(home, ".copilot", "hooks"), { recursive: true });
  writeFileSync(hooksPath(), `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function readHooks(): Record<string, unknown> {
  return JSON.parse(readFileSync(hooksPath(), "utf8")) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-copilot-"));
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

describe("copilot.normalize", () => {
  it("should_map_agent_stop_payload_to_a_done_event", () => {
    const event = copilot.normalize(AGENT_STOP_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("copilot");
    expect(event?.agentTitle).toBe("GitHub Copilot");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_map_notification_payload_to_a_blocked_event_with_message_summary", () => {
    const event = copilot.normalize(NOTIFICATION_PAYLOAD, "blocked");
    expect(event?.event).toBe("blocked");
    expect(event?.summary).toBe("Copilot is waiting for your input");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(copilot.normalize("nope", "done")).toBeNull();
    expect(copilot.normalize(null, "done")).toBeNull();
    expect(copilot.normalize(42, "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_payload_omits_it", () => {
    const event = copilot.normalize({ stopReason: "end_turn" }, "done");
    expect(event?.cwd).toBe("");
  });
});

describe("copilot.readLastResponse", () => {
  it("should_return_the_last_assistant_message_text", async () => {
    const text = await copilot.readLastResponse({
      transcriptPath: EVENTS_FIXTURE,
    });
    expect(text).toBe("All done. Tests pass.");
  });

  it("should_skip_a_malformed_json_line", async () => {
    const path = join(tmpRoot, "malformed.jsonl");
    writeFileSync(
      path,
      '{"type":"assistant.message","data":{"text":"good"}}\n' + "{broken json\n",
      "utf8",
    );
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBe(
      "good",
    );
  });

  it("should_return_null_for_a_missing_file", async () => {
    expect(
      await copilot.readLastResponse({ transcriptPath: "/nonexistent/x.jsonl" }),
    ).toBeNull();
  });

  it("should_ignore_non_assistant_lines", async () => {
    const path = join(tmpRoot, "user-only.jsonl");
    writeFileSync(path, '{"type":"user.message","data":{"text":"hi"}}\n', "utf8");
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBeNull();
  });

  it("should_read_only_the_last_2mb_tail_and_find_the_final_message", async () => {
    const path = join(tmpRoot, "big.jsonl");
    const filler = `${"x".repeat(2_100_000)}\n`;
    const line = '{"type":"assistant.message","data":{"text":"tail wins"}}\n';
    writeFileSync(path, filler + line, "utf8");
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBe(
      "tail wins",
    );
  });

  it("should_return_null_when_raw_lacks_a_transcript_path", async () => {
    expect(await copilot.readLastResponse({})).toBeNull();
    expect(await copilot.readLastResponse("nope")).toBeNull();
  });

  it("should_read_text_from_a_content_string_field", async () => {
    const path = join(tmpRoot, "content-string.jsonl");
    writeFileSync(
      path,
      '{"type":"assistant.message","data":{"content":"via content"}}\n',
      "utf8",
    );
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBe(
      "via content",
    );
  });

  it("should_read_text_from_a_message_string_field", async () => {
    const path = join(tmpRoot, "message-string.jsonl");
    writeFileSync(
      path,
      '{"type":"assistant.message","data":{"message":"via message"}}\n',
      "utf8",
    );
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBe(
      "via message",
    );
  });

  it("should_join_a_content_array_of_text_blocks", async () => {
    const path = join(tmpRoot, "content-array.jsonl");
    writeFileSync(
      path,
      '{"type":"assistant.message","data":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}\n',
      "utf8",
    );
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBe(
      "a b",
    );
  });

  it("should_return_null_when_assistant_data_carries_no_text", async () => {
    const path = join(tmpRoot, "empty-data.jsonl");
    writeFileSync(
      path,
      '{"type":"assistant.message","data":{"tokens":5}}\n',
      "utf8",
    );
    expect(await copilot.readLastResponse({ transcriptPath: path })).toBeNull();
  });
});

describe("copilot.wire", () => {
  it("should_add_both_agent_stop_and_notification_hooks", async () => {
    const result = await copilot.wire(deps());
    expect(result.changed).toBe(true);
    expect(result.diff).toContain(DONE_COMMAND);
    expect(result.diff).toContain(BLOCKED_COMMAND);
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.agentStop)).toContain(DONE_COMMAND);
    expect(JSON.stringify(hooks.notification)).toContain(BLOCKED_COMMAND);
    expect(readHooks().version).toBe(1);
  });

  it("should_preserve_an_existing_unrelated_hook", async () => {
    writeHooks({
      version: 1,
      hooks: {
        preToolUse: [{ type: "command", command: "audit.sh" }],
      },
    });
    await copilot.wire(deps());
    const hooks = readHooks().hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.preToolUse)).toContain("audit.sh");
    expect(JSON.stringify(hooks.agentStop)).toContain(DONE_COMMAND);
    expect(JSON.stringify(hooks.notification)).toContain(BLOCKED_COMMAND);
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await copilot.wire(deps());
    const second = await copilot.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    const hooks = readHooks().hooks as Record<
      string,
      Array<{ command: string }>
    >;
    expect(hooks.agentStop).toHaveLength(1);
    expect(hooks.notification).toHaveLength(1);
  });
});

describe("copilot.unwire", () => {
  it("should_restore_prior_hooks_byte_identically", async () => {
    writeHooks({
      version: 1,
      hooks: { preToolUse: [{ type: "command", command: "audit.sh" }] },
    });
    const original = readFileSync(hooksPath(), "utf8");
    await copilot.wire(deps());
    expect(readFileSync(hooksPath(), "utf8")).not.toBe(original);
    await copilot.unwire(deps());
    expect(readFileSync(hooksPath(), "utf8")).toBe(original);
  });

  it("should_delete_hooks_file_that_did_not_exist_before_wiring", async () => {
    await copilot.wire(deps());
    expect(existsSync(hooksPath())).toBe(true);
    await copilot.unwire(deps());
    expect(existsSync(hooksPath())).toBe(false);
  });

  afterEach(() => {
    unwireFromLedger(LEDGER_KEY);
  });
});

describe("copilot.detect", () => {
  it("should_report_installed_when_the_dot_copilot_dir_exists", async () => {
    mkdirSync(join(home, ".copilot"), { recursive: true });
    const detection = await copilot.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(hooksPath());
  });

  it("should_report_installed_when_copilot_is_on_path", async () => {
    const detection = await copilot.detect(deps(whichCopilot));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await copilot.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });
});
