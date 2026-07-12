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
import { opencode } from "../../src/adapters/opencode.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const FIXTURES = join(__dirname, "..", "fixtures", "opencode");
const SESSION_IDLE_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "session-idle.json"), "utf8"),
) as Record<string, unknown>;
const PERMISSION_ASKED_PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "permission-asked.json"), "utf8"),
) as Record<string, unknown>;

const LEDGER_KEY = "opencode";

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

const whichNone = (): string | null => null;
const whichOpencode = (bin: string): string | null =>
  bin === "opencode" ? "/Users/me/.local/bin/opencode" : null;

function deps(which: (bin: string) => string | null = whichNone): AdapterDeps {
  return { home, which };
}

function pluginPath(): string {
  return join(home, ".config", "opencode", "plugin", "hollr.js");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-opencode-"));
  home = join(tmpRoot, "home");
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  mkdirSync(home, { recursive: true });
  prevHollrHome = process.env.HOLLR_HOME;
  process.env.HOLLR_HOME = hollrHomeDir;
});

afterEach(() => {
  unwireFromLedger(LEDGER_KEY);
  if (prevHollrHome === undefined) {
    delete process.env.HOLLR_HOME;
  } else {
    process.env.HOLLR_HOME = prevHollrHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("opencode.capabilities", () => {
  it("should_advertise_done_blocked_but_not_readaloud_or_slash_command", () => {
    // Read-aloud is disabled: opencode's storage (message + part split) is an
    // undocumented internal shape with known churn, so hollr degrades to announce.
    expect(opencode.capabilities).toEqual({
      done: true,
      blocked: true,
      readAloud: false,
      slashCommand: false,
      instructionInjection: false,
    });
  });
});

describe("opencode.normalize", () => {
  it("should_map_the_session_idle_payload_to_a_done_event", () => {
    const event = opencode.normalize(SESSION_IDLE_PAYLOAD, "done");
    expect(event).not.toBeNull();
    expect(event?.agent).toBe("opencode");
    expect(event?.agentTitle).toBe("opencode");
    expect(event?.event).toBe("done");
    expect(event?.cwd).toBe("/Users/me/dev/my-app");
    expect(event?.project).toBe("my app");
    expect(event?.lastResponse).toBeNull();
    expect(event?.v).toBe(1);
    expect(typeof event?.ts).toBe("string");
  });

  it("should_map_the_permission_asked_payload_to_a_blocked_event", () => {
    const event = opencode.normalize(PERMISSION_ASKED_PAYLOAD, "blocked");
    expect(event?.event).toBe("blocked");
    expect(event?.cwd).toBe("/Users/me/dev/other-app");
    expect(event?.project).toBe("other app");
  });

  it("should_return_null_when_raw_is_not_an_object", () => {
    expect(opencode.normalize("nope", "done")).toBeNull();
    expect(opencode.normalize(null, "done")).toBeNull();
    expect(opencode.normalize(42, "done")).toBeNull();
    expect(opencode.normalize(["a"], "done")).toBeNull();
  });

  it("should_leave_cwd_empty_when_cwd_is_missing_or_non_string", () => {
    expect(opencode.normalize({ sessionID: "1" }, "done")?.cwd).toBe("");
    expect(opencode.normalize({ cwd: 5 }, "done")?.cwd).toBe("");
  });
});

describe("opencode.readLastResponse", () => {
  it("should_always_return_null_and_never_throw", async () => {
    expect(await opencode.readLastResponse(SESSION_IDLE_PAYLOAD)).toBeNull();
    expect(await opencode.readLastResponse({})).toBeNull();
    expect(await opencode.readLastResponse("nope")).toBeNull();
    expect(await opencode.readLastResponse(null)).toBeNull();
  });
});

describe("opencode.wire plugin template", () => {
  it("should_write_a_hollr_js_plugin_that_subscribes_to_the_verified_events", async () => {
    const result = await opencode.wire(deps());
    expect(result.changed).toBe(true);
    expect(existsSync(pluginPath())).toBe(true);
    const plugin = readFileSync(pluginPath(), "utf8");
    // Plugin module export shape (opencode Plugin: async fn returning hooks).
    expect(plugin).toContain("export const hollr");
    expect(plugin).toContain("event: async ({ event })");
    // Verified event subscriptions.
    expect(plugin).toContain('event.type === "session.idle"');
    expect(plugin).toContain('event.type === "permission.asked"');
    // Shells out to the hollr CLI for both mapped events.
    expect(plugin).toContain("hollr emit --agent opencode");
    expect(plugin).toContain("--event ${event} --payload-argv ${payload}");
    expect(plugin).toContain('emit("done"');
    expect(plugin).toContain('emit("blocked"');
  });

  it("should_be_idempotent_on_a_second_wire", async () => {
    await opencode.wire(deps());
    const first = readFileSync(pluginPath(), "utf8");
    const second = await opencode.wire(deps());
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
    expect(readFileSync(pluginPath(), "utf8")).toBe(first);
  });
});

describe("opencode.unwire", () => {
  it("should_delete_the_plugin_file_on_unwire", async () => {
    const testDeps = deps();
    await opencode.wire(testDeps);
    expect(existsSync(pluginPath())).toBe(true);
    await opencode.unwire(testDeps);
    expect(existsSync(pluginPath())).toBe(false);
  });

  it("should_delete_a_pre_existing_plugin_file_outright_not_restore_it", async () => {
    // unwireCreatedFile always deletes the file it owns: the plugin is a whole
    // file hollr owns outright, not a section of a shared config, so unwire
    // does not attempt to restore whatever (if anything) was there before.
    mkdirSync(join(home, ".config", "opencode", "plugin"), { recursive: true });
    writeFileSync(pluginPath(), "export const mine = async () => ({});\n", "utf8");
    await opencode.wire(deps());
    await opencode.unwire(deps());
    expect(existsSync(pluginPath())).toBe(false);
  });
});

describe("opencode.detect", () => {
  it("should_report_installed_when_opencode_is_on_path", async () => {
    const detection = await opencode.detect(deps(whichOpencode));
    expect(detection.installed).toBe(true);
    expect(detection.configPath).toBe(pluginPath());
  });

  it("should_report_installed_when_the_config_dir_exists", async () => {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const detection = await opencode.detect(deps(whichNone));
    expect(detection.installed).toBe(true);
  });

  it("should_report_not_installed_on_a_bare_home", async () => {
    const detection = await opencode.detect(deps(whichNone));
    expect(detection.installed).toBe(false);
  });
});
