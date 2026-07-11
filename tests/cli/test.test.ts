import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookTarget } from "../../src/core/config.ts";
import type { HollrEvent } from "../../src/core/events.ts";
import { projectLabel } from "../../src/core/events.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { SpeakSequencedOptions } from "../../src/platform/sequencer.ts";
import type { TestDeps } from "../../src/cli/test.ts";
import { runTest } from "../../src/cli/test.ts";

const NOW = new Date("2026-07-11T12:00:00.000Z");

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-test-"));
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

/** Writing a global config makes every cwd "configured" (isConfigured true). */
function configureGlobal(overrides: Record<string, unknown> = {}): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  writeFileSync(join(hollrHomeDir, "config.json"), JSON.stringify(overrides));
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
  deps: TestDeps;
  speak: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  webhooks: ReturnType<typeof vi.fn>;
  out: ReturnType<typeof vi.fn>;
}

function makeDeps(): Harness {
  const speak = vi.fn<(opts: SpeakSequencedOptions) => void>();
  const notify = vi.fn<(argv: string[]) => void>();
  const webhooks =
    vi.fn<(ev: HollrEvent, targets: WebhookTarget[], allowHttp: boolean) => void>();
  const out = vi.fn<(text: string) => void>();
  const deps: TestDeps = {
    cwd: process.cwd(),
    platform: fakePlatform(),
    speak,
    notify,
    webhooks,
    awaitWebhooks: () => Promise.resolve(),
    out,
  };
  return { deps, speak, notify, webhooks, out };
}

function spokenText(speak: ReturnType<typeof vi.fn>): string {
  const call = speak.mock.calls[0];
  expect(call).toBeDefined();
  return (call?.[0] as SpeakSequencedOptions).text;
}

function outText(out: ReturnType<typeof vi.fn>): string {
  return out.mock.calls.map((call) => String(call[0])).join("");
}

describe("runTest default (live local check)", () => {
  it("should_drive_local_sinks_with_the_hollr_done_line_and_not_fire_webhooks", async () => {
    configureGlobal();
    const { deps, speak, notify, webhooks } = makeDeps();
    const code = await runTest([], deps, NOW);
    expect(code).toBe(0);
    expect(spokenText(speak)).toBe(
      `hollr response is ready in ${projectLabel(process.cwd())}`,
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(webhooks).not.toHaveBeenCalled();
  });

  it("should_append_the_synthetic_event_to_events_log", async () => {
    configureGlobal();
    const { deps } = makeDeps();
    await runTest([], deps, NOW);
    const line = readEventsLog();
    expect(line).toContain("hollr-test done");
  });
});

function readEventsLog(): string {
  return readFileSync(join(hollrHomeDir, "events.log"), "utf8").trim();
}

describe("runTest --webhook", () => {
  it("should_also_fire_webhooks_with_config_targets", async () => {
    configureGlobal({ allowHttp: false });
    const { deps, webhooks } = makeDeps();
    const code = await runTest(["--webhook"], deps, NOW);
    expect(code).toBe(0);
    expect(webhooks).toHaveBeenCalledTimes(1);
    const call = webhooks.mock.calls[0];
    expect(call?.[2]).toBe(false); // allowHttp threaded from config
  });
});

describe("runTest --show-payload", () => {
  it("should_print_webhook_payload_json_and_send_nothing", async () => {
    configureGlobal();
    const { deps, speak, notify, webhooks, out } = makeDeps();
    const code = await runTest(["--show-payload"], deps, NOW);
    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(webhooks).not.toHaveBeenCalled();
    const payload = JSON.parse(outText(out)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: 1,
      agent: "hollr-test",
      event: "done",
      summary: "hollr test",
      project: projectLabel(process.cwd()),
    });
    expect(payload.ts).toBe(NOW.toISOString());
  });

  it("should_take_precedence_over_webhook_and_send_nothing", async () => {
    configureGlobal();
    const { deps, speak, webhooks, out } = makeDeps();
    const code = await runTest(["--webhook", "--show-payload"], deps, NOW);
    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(webhooks).not.toHaveBeenCalled();
    expect(outText(out).length).toBeGreaterThan(0);
  });
});
