import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeCwd, type WebhookTarget } from "../../src/core/config.ts";
import type { KelbrinEvent } from "../../src/core/events.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { SpeakSequencedOptions } from "../../src/platform/sequencer.ts";
import type { EmitDeps } from "../../src/cli/emit.ts";
import { runEmit } from "../../src/cli/emit.ts";
import { fireWebhooks } from "../../src/sinks/webhook.ts";

const CWD = "/Users/me/dev/my-app";

let tmpRoot: string;
let kelbrinHomeDir: string;
let logPath: string;
let prevKelbrinHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-seam-"));
  kelbrinHomeDir = join(tmpRoot, ".config", "kelbrin");
  mkdirSync(kelbrinHomeDir, { recursive: true });
  logPath = join(kelbrinHomeDir, "webhook.log");
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
  vi.useRealTimers();
});

const WEBHOOK: WebhookTarget = {
  name: "seam",
  provider: "generic",
  url: "https://hook.example/x",
  events: ["done"],
};

function configureGlobal(overrides: Record<string, unknown>): void {
  writeFileSync(join(kelbrinHomeDir, "config.json"), JSON.stringify(overrides));
}

function fakePlatform(): Platform {
  return {
    id: "darwin",
    voiceArgv: () => ["say", "text"],
    notifyArgv: () => null,
    soundArgv: () => ["afplay", "sound"],
    enumerateVoicesArgv: () => null,
    parseVoicesOutput: () => [],
    canPauseResume: true,
    requiredBinaries: [],
  };
}

interface SeamHarness {
  deps: EmitDeps;
  calls: number[];
}

/** Mirrors realEmitDeps' collector wiring but injects a mock fetch. */
function makeSeamDeps(fetchFn: typeof fetch): SeamHarness {
  const calls: number[] = [];
  const wrapped = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push(1);
    return fetchFn(url, init);
  }) as typeof fetch;
  let pending: Promise<void> = Promise.resolve();
  const deps: EmitDeps = {
    readStdin: () => Promise.resolve(""),
    platform: fakePlatform(),
    speak: vi.fn<(opts: SpeakSequencedOptions) => void>(),
    notify: vi.fn<(argv: string[]) => void>(),
    webhooks: (ev: KelbrinEvent, targets: WebhookTarget[], allowHttp: boolean) => {
      pending = fireWebhooks(ev, targets, { allowHttp, fetchFn: wrapped, logPath });
    },
    awaitWebhooks: () => pending,
  };
  return { deps, calls };
}

const EMIT_ARGS = [
  "--agent",
  "claude-code",
  "--event",
  "done",
  "--payload-argv",
  JSON.stringify({ cwd: CWD }),
];

describe("emit → webhook async seam", () => {
  it("should_call_and_await_the_webhook_before_resolving", async () => {
    configureGlobal({ webhooks: [WEBHOOK], allowHttp: false });
    let completed = false;
    const fetchFn = (() => {
      completed = true;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof fetch;
    const { deps, calls } = makeSeamDeps(fetchFn);
    const code = await runEmit(EMIT_ARGS, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(completed).toBe(true);
  });

  it("should_bound_a_hanging_webhook_by_the_6s_cap", async () => {
    vi.useFakeTimers();
    configureGlobal({ webhooks: [WEBHOOK], allowHttp: false });
    const hanging = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const { deps, calls } = makeSeamDeps(hanging);
    let resolved = false;
    const promise = runEmit(EMIT_ARGS, deps).then((code) => {
      resolved = true;
      return code;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    const code = await promise;
    expect(resolved).toBe(true);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("should_not_fire_webhooks_for_a_muted_project", async () => {
    configureGlobal({ webhooks: [WEBHOOK], allowHttp: false });
    const projects = join(kelbrinHomeDir, "projects");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${encodeCwd(CWD)}.muted`), "");
    const fetchFn = (() =>
      Promise.resolve(new Response("", { status: 200 }))) as typeof fetch;
    const { deps, calls } = makeSeamDeps(fetchFn);
    const code = await runEmit(EMIT_ARGS, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
