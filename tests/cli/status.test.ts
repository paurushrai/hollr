import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULTS, encodeCwd } from "../../src/core/config.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { StatusIo } from "../../src/cli/status.ts";
import { formatStatus, runStatus } from "../../src/cli/status.ts";

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-status-"));
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

function fakePlatform(canPauseResume: boolean): Platform {
  return {
    id: "darwin",
    voiceArgv: () => null,
    notifyArgv: () => null,
    soundArgv: () => null,
    enumerateVoicesArgv: () => null,
    parseVoicesOutput: () => [],
    canPauseResume,
    requiredBinaries: [],
  };
}

interface Harness {
  io: StatusIo;
  out: ReturnType<typeof vi.fn>;
}

function makeIo(canPauseResume = true): Harness {
  const out = vi.fn<(text: string) => void>();
  const io: StatusIo = { cwd: process.cwd(), platform: fakePlatform(canPauseResume), out };
  return { io, out };
}

function outText(out: ReturnType<typeof vi.fn>): string {
  return out.mock.calls.map((call) => String(call[0])).join("");
}

function writeGlobal(config: Record<string, unknown>): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  writeFileSync(join(hollrHomeDir, "config.json"), JSON.stringify(config));
}

function writeLedger(keys: string[]): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  const entries = keys.map((ledgerKey) => ({
    ledgerKey,
    path: "/some/file",
    before: null,
    at: "2026-07-11T00:00:00.000Z",
  }));
  writeFileSync(join(hollrHomeDir, "wired.json"), JSON.stringify(entries));
}

function writeLog(name: string, lines: string[]): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  writeFileSync(join(hollrHomeDir, name), `${lines.join("\n")}\n`);
}

describe("runStatus report", () => {
  it("should_list_wired_adapter_titles_and_config_and_logs", () => {
    writeGlobal({
      events: { done: { mode: "readaloud" }, error: { mode: "silent" } },
      voice: { name: "Daniel", rateWpm: 200 },
      quietHours: "22:00-07:00",
      webhooks: [
        { name: "phone", provider: "ntfy", url: "https://x", events: ["done"] },
        { name: "team", provider: "slack", url: "https://y", events: ["error"] },
      ],
    });
    writeLedger(["claude-code:settings"]);
    writeLog("webhook.log", ["l1", "l2", "l3", "l4", "l5", "l6"]);
    writeLog("events.log", ["e1", "e2", "e3", "e4", "e5", "e6"]);

    const { io, out } = makeIo(true);
    expect(runStatus(io)).toBe(0);
    const text = outText(out);

    expect(text).toContain("Claude Code");
    expect(text).toContain("readaloud");
    expect(text).toContain("silent");
    expect(text).toContain("Daniel");
    expect(text).toContain("200");
    expect(text).toContain("22:00-07:00");
    expect(text).toContain("phone");
    expect(text).toContain("team");
    expect(text).toContain("Muted: no");
    // last-5 windowing: earliest line dropped, newest kept.
    expect(text).toContain("l6");
    expect(text).not.toContain("l1");
    expect(text).toContain("e6");
    expect(text).not.toContain("e1");
  });

  it("should_show_secrets_free_webhook_names_only", () => {
    writeGlobal({
      webhooks: [
        {
          name: "phone",
          provider: "ntfy",
          url: "https://ntfy.example/secret-topic",
          events: ["done"],
          headers: { Authorization: "Bearer super-secret" },
        },
      ],
    });
    const { io, out } = makeIo();
    runStatus(io);
    const text = outText(out);
    expect(text).toContain("phone");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("secret-topic");
    expect(text).not.toContain("Authorization");
  });

  it("should_report_muted_when_flag_present", () => {
    writeGlobal({});
    mkdirSync(join(hollrHomeDir, "projects"), { recursive: true });
    writeFileSync(join(hollrHomeDir, "projects", `${encodeCwd(process.cwd())}.muted`), "");
    const { io, out } = makeIo();
    runStatus(io);
    expect(outText(out)).toContain("Muted: yes");
  });

  it("should_report_pause_resume_capability", () => {
    writeGlobal({});
    const { io, out } = makeIo(false);
    runStatus(io);
    expect(outText(out).toLowerCase()).toContain("pause");
  });

  it("should_degrade_cleanly_when_ledger_and_logs_absent", () => {
    const { io, out } = makeIo();
    expect(runStatus(io)).toBe(0);
    const text = outText(out);
    expect(text.toLowerCase()).toContain("none");
  });
});

describe("formatStatus (pure)", () => {
  it("should_render_none_for_empty_wired_and_logs", () => {
    const text = formatStatus({
      cwd: "/tmp/demo-app",
      config: DEFAULTS,
      muted: false,
      canPauseResume: true,
      wiredKeys: [],
      webhookLog: [],
      eventsLog: [],
    });
    expect(text.toLowerCase()).toContain("none");
    expect(text).toContain("demo app");
  });

  it("should_fall_back_to_the_raw_key_for_unknown_adapter", () => {
    const text = formatStatus({
      cwd: "/tmp/demo",
      config: DEFAULTS,
      muted: false,
      canPauseResume: true,
      wiredKeys: ["mystery-agent:file"],
      webhookLog: [],
      eventsLog: [],
    });
    expect(text).toContain("mystery-agent:file");
  });
});
