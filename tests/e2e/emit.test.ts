/**
 * End-to-end wiring: a claude-code hook payload arriving on stdin flows through
 * `hollr emit` → adapter normalize → router → sinks, with the platform engines
 * mocked. These tests never touch the real `~`, real audio, or the network; a
 * temp `HOLLR_HOME` holds config, mute flags, and any transcript fixtures.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claudeCode } from "../../src/adapters/claude-code.ts";
import type { EmitDeps } from "../../src/cli/emit.ts";
import { runEmit } from "../../src/cli/emit.ts";
import { encodeCwd, type WebhookTarget } from "../../src/core/config.ts";
import type { HollrEvent } from "../../src/core/events.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { SpeakSequencedOptions } from "../../src/platform/sequencer.ts";

/** cwd whose basename ("my-app") speaks as the brief's canonical "my app". */
const FIXTURE_CWD = "/Users/me/dev/my-app";
const DONE_LINE = "Claude Code response is ready in my app";
const BLOCKED_LINE = "Claude Code needs your input in my app";
/** Last assistant turn in the transcript fixture, prepared for speech. */
const TRANSCRIPT_SPOKEN = "All done. Tests pass.";

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-e2e-"));
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

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/claude-code/${name}`, import.meta.url));
}

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Writing a global config marks every cwd "configured"; overrides merge in. */
function configureGlobal(overrides: Record<string, unknown> = {}): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  writeFileSync(join(hollrHomeDir, "config.json"), JSON.stringify(overrides));
}

/** Drop a `.muted` flag for `cwd` under the temp home's projects/ dir. */
function muteProject(cwd: string): void {
  const dir = join(hollrHomeDir, "projects");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encodeCwd(cwd)}.muted`), "");
}

/** Copy the transcript fixture into the temp home and return its path. */
function writeTranscript(): string {
  const dest = join(hollrHomeDir, "transcript.jsonl");
  mkdirSync(hollrHomeDir, { recursive: true });
  writeFileSync(dest, readFileSync(fixturePath("transcript.jsonl"), "utf8"));
  return dest;
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

function makeDeps(stdin: string): Harness {
  const speak = vi.fn<(opts: SpeakSequencedOptions) => void>();
  const notify = vi.fn<(argv: string[]) => void>();
  const webhooks =
    vi.fn<(ev: HollrEvent, targets: WebhookTarget[], allowHttp: boolean) => void>();
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

const STOP_ARGS = [
  "--agent",
  "claude-code",
  "--event",
  "done",
  "--payload-stdin",
];
const NOTIFICATION_ARGS = [
  "--agent",
  "claude-code",
  "--event",
  "blocked",
  "--payload-stdin",
];

describe("emit e2e: claude-code payloads through to sinks", () => {
  it("should_speak_the_canonical_done_line_when_stop_configured_announce", async () => {
    configureGlobal();
    const { deps, speak, notify } = makeDeps(JSON.stringify(loadFixture("stop.json")));

    const code = await runEmit(STOP_ARGS, deps);

    expect(code).toBe(0);
    expect(spokenText(speak)).toBe(DONE_LINE);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("should_speak_the_transcript_text_when_done_configured_readaloud", async () => {
    configureGlobal({ events: { done: { mode: "readaloud" } } });
    const payload = { ...loadFixture("stop.json"), transcript_path: writeTranscript() };
    const readSpy = vi.spyOn(claudeCode, "readLastResponse");
    const { deps, speak } = makeDeps(JSON.stringify(payload));

    const code = await runEmit(STOP_ARGS, deps);

    expect(code).toBe(0);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(spokenText(speak)).toBe(TRANSCRIPT_SPOKEN);
    expect(spokenText(speak)).not.toBe(DONE_LINE);
  });

  it("should_not_read_the_transcript_when_done_configured_announce", async () => {
    configureGlobal({ events: { done: { mode: "announce" } } });
    // A transcript that WOULD change the spoken text if wrongly read.
    const payload = { ...loadFixture("stop.json"), transcript_path: writeTranscript() };
    const readSpy = vi.spyOn(claudeCode, "readLastResponse");
    const { deps, speak } = makeDeps(JSON.stringify(payload));

    const code = await runEmit(STOP_ARGS, deps);

    expect(code).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    expect(spokenText(speak)).toBe(DONE_LINE);
  });

  it("should_speak_the_blocked_line_for_a_notification_payload", async () => {
    configureGlobal();
    const { deps, speak } = makeDeps(
      JSON.stringify(loadFixture("notification.json")),
    );

    const code = await runEmit(NOTIFICATION_ARGS, deps);

    expect(code).toBe(0);
    expect(spokenText(speak)).toBe(BLOCKED_LINE);
  });

  it("should_call_no_sinks_when_the_project_is_muted", async () => {
    configureGlobal();
    muteProject(FIXTURE_CWD);
    const { deps, speak, notify } = makeDeps(
      JSON.stringify(loadFixture("stop.json")),
    );

    const code = await runEmit(STOP_ARGS, deps);

    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("should_show_the_setup_hint_once_then_stay_silent_when_unconfigured", async () => {
    // No config file written → isConfigured() is false.
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { deps } = makeDeps(JSON.stringify(loadFixture("stop.json")));

    const first = await runEmit(STOP_ARGS, deps);
    const second = await runEmit(STOP_ARGS, deps);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
