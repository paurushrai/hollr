import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KelbrinEvent } from "../../src/core/events.ts";
import { projectLabel } from "../../src/core/events.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { SpeakSequencedOptions } from "../../src/platform/sequencer.ts";
import type { WebhookTarget } from "../../src/core/config.ts";
import type { EmitDeps, EmitFlags } from "../../src/cli/emit.ts";
import { buildEmitEvent, runEmit } from "../../src/cli/emit.ts";

const CWD = "/Users/me/dev/my-app";
const ONE_MB = 1024 * 1024;

let tmpRoot: string;
let kelbrinHomeDir: string;
let prevKelbrinHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-emit-"));
  kelbrinHomeDir = join(tmpRoot, ".config", "kelbrin");
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
  vi.restoreAllMocks();
});

/** Writing a global config makes every cwd "configured" (isConfigured true). */
function configureGlobal(overrides: Record<string, unknown> = {}): void {
  mkdirSync(kelbrinHomeDir, { recursive: true });
  writeFileSync(join(kelbrinHomeDir, "config.json"), JSON.stringify(overrides));
}

function fakePlatform(): Platform {
  return {
    id: "darwin",
    voiceArgv: () => ["say", "text"],
    notifyArgv: (title, body) => ["notify", title, body],
    soundArgv: () => ["afplay", "sound"],
    enumerateVoicesArgv: () => null,
    parseVoicesOutput: () => [],
    canPauseResume: true,
    requiredBinaries: [],
  };
}

interface Harness {
  deps: EmitDeps;
  speak: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  webhooks: ReturnType<typeof vi.fn>;
}

function makeDeps(stdin = ""): Harness {
  const speak = vi.fn<(opts: SpeakSequencedOptions) => void>();
  const notify = vi.fn<(argv: string[]) => void>();
  const webhooks =
    vi.fn<(ev: KelbrinEvent, targets: WebhookTarget[], allowHttp: boolean) => void>();
  const deps: EmitDeps = {
    readStdin: () => Promise.resolve(stdin),
    platform: fakePlatform(),
    speak,
    notify,
    webhooks,
    awaitWebhooks: () => Promise.resolve(),
  };
  return { deps, speak, notify, webhooks };
}

function spokenText(speak: ReturnType<typeof vi.fn>): string {
  const call = speak.mock.calls[0];
  expect(call).toBeDefined();
  return (call?.[0] as SpeakSequencedOptions).text;
}

describe("buildEmitEvent (generic normalizer)", () => {
  const baseFlags: EmitFlags = {
    agent: "claude-code",
    event: "done",
    summary: null,
    payloadStdin: false,
    payloadArgv: null,
  };
  const NOW = new Date("2026-07-11T12:00:00.000Z");

  it("should_use_id_as_agent_and_agent_title", () => {
    const ev = buildEmitEvent(baseFlags, {}, NOW);
    expect(ev.agent).toBe("claude-code");
    expect(ev.agentTitle).toBe("claude-code");
    expect(ev.v).toBe(1);
    expect(ev.event).toBe("done");
    expect(ev.ts).toBe("2026-07-11T12:00:00.000Z");
  });

  it("should_default_cwd_to_process_cwd_when_payload_has_none", () => {
    const ev = buildEmitEvent(baseFlags, {}, NOW);
    expect(ev.cwd).toBe(process.cwd());
    expect(ev.project).toBe(projectLabel(process.cwd()));
  });

  it("should_take_cwd_from_payload_when_present", () => {
    const ev = buildEmitEvent(baseFlags, { cwd: CWD }, NOW);
    expect(ev.cwd).toBe(CWD);
    expect(ev.project).toBe("my app");
  });

  it("should_prefer_summary_flag_over_payload_summary", () => {
    const ev = buildEmitEvent(
      { ...baseFlags, summary: "from flag" },
      { summary: "from payload" },
      NOW,
    );
    expect(ev.summary).toBe("from flag");
  });

  it("should_fall_back_to_payload_summary_then_empty", () => {
    expect(buildEmitEvent(baseFlags, { summary: "p" }, NOW).summary).toBe("p");
    expect(buildEmitEvent(baseFlags, {}, NOW).summary).toBe("");
  });

  it("should_default_last_response_to_null_and_read_it_from_payload", () => {
    expect(buildEmitEvent(baseFlags, {}, NOW).lastResponse).toBeNull();
    expect(buildEmitEvent(baseFlags, { lastResponse: "hi" }, NOW).lastResponse).toBe("hi");
  });
});

describe("runEmit drives route", () => {
  it("should_normalize_stdin_payload_and_speak_the_done_line", async () => {
    configureGlobal();
    const { deps, speak, notify } = makeDeps(JSON.stringify({ cwd: CWD }));
    const code = await runEmit(
      ["--agent", "claude-code", "--event", "done", "--payload-stdin"],
      deps,
    );
    expect(code).toBe(0);
    expect(spokenText(speak)).toBe("Claude Code response is ready in my app");
    expect(notify).toHaveBeenCalledTimes(1);
    const logLine = readFileSync(join(kelbrinHomeDir, "events.log"), "utf8").trim();
    expect(logLine).toContain("claude-code done my app");
  });

  it("should_use_the_blocked_line_from_payload_argv", async () => {
    configureGlobal();
    const { deps, speak } = makeDeps();
    const code = await runEmit(
      [
        "--agent",
        "claude-code",
        "--event",
        "blocked",
        "--payload-argv",
        JSON.stringify({ cwd: CWD }),
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(spokenText(speak)).toBe("Claude Code needs your input in my app");
  });

  it("should_return_0_and_not_throw_on_malformed_stdin", async () => {
    configureGlobal();
    const { deps } = makeDeps("this is not json {{{");
    let code: number | undefined;
    await expect(
      (async () => {
        code = await runEmit(
          ["--agent", "x", "--event", "done", "--payload-stdin"],
          deps,
        );
      })(),
    ).resolves.toBeUndefined();
    expect(code).toBe(0);
  });

  it("should_return_0_on_oversized_stdin", async () => {
    configureGlobal();
    const oversized = `{"cwd":"${"x".repeat(ONE_MB + 10)}"}`;
    const { deps, speak } = makeDeps(oversized);
    const code = await runEmit(
      ["--agent", "x", "--event", "done", "--payload-stdin"],
      deps,
    );
    expect(code).toBe(0);
    // Oversized payload is ignored, so cwd falls back to process.cwd().
    expect(spokenText(speak)).toContain("response is ready");
  });

  it("should_default_payload_to_empty_when_no_source_flag", async () => {
    configureGlobal();
    const { deps, speak } = makeDeps();
    const code = await runEmit(["--agent", "x", "--event", "done"], deps);
    expect(code).toBe(0);
    expect(spokenText(speak)).toBe(
      `x response is ready in ${projectLabel(process.cwd())}`,
    );
  });
});
