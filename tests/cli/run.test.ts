import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HollrEvent } from "../../src/core/events.ts";
import type { Platform } from "../../src/platform/index.ts";
import type { SpeakSequencedOptions } from "../../src/platform/sequencer.ts";
import type { WebhookTarget } from "../../src/core/config.ts";
import { encodeCwd } from "../../src/core/config.ts";
import type { StdioMode, WrapperChild, WrapperDeps } from "../../src/cli/run.ts";
import { runWrapper } from "../../src/cli/run.ts";

const CWD = "/Users/me/dev/my-app";
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "cursor-stream.ndjson",
);

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-run-"));
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

/** A controllable fake child: drive stdout + exit/error from the test. */
class FakeChild extends EventEmitter implements WrapperChild {
  readonly stdout: EventEmitter | null;
  constructor(mode: StdioMode) {
    super();
    this.stdout = mode === "stream" ? new EventEmitter() : null;
  }
  pushStdout(chunk: string): void {
    this.stdout?.emit("data", Buffer.from(chunk, "utf8"));
  }
  pushStdoutBytes(chunk: Buffer): void {
    this.stdout?.emit("data", chunk);
  }
  endStdout(): void {
    this.stdout?.emit("end");
  }
  exit(code: number | null): void {
    this.emit("exit", code);
  }
  fail(err: Error): void {
    this.emit("error", err);
  }
}

interface Harness {
  deps: WrapperDeps;
  spawn: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  out: ReturnType<typeof vi.fn>;
  child(): FakeChild;
}

function makeHarness(): Harness {
  let created: FakeChild | undefined;
  const spawn = vi.fn(
    (_cmd: string, _args: string[], mode: StdioMode): WrapperChild => {
      created = new FakeChild(mode);
      return created;
    },
  );
  const speak = vi.fn<(opts: SpeakSequencedOptions) => void>();
  const notify = vi.fn<(argv: string[]) => void>();
  const out = vi.fn<(chunk: string) => void>();
  const deps: WrapperDeps = {
    spawn,
    out,
    cwd: CWD,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    platform: fakePlatform(),
    speak,
    notify,
    webhooks: vi.fn<
      (ev: HollrEvent, targets: WebhookTarget[], allowHttp: boolean) => void
    >(),
    awaitWebhooks: () => Promise.resolve(),
  };
  return {
    deps,
    spawn,
    speak,
    notify,
    out,
    child: () => {
      if (created === undefined) {
        throw new Error("spawn was not called");
      }
      return created;
    },
  };
}

function spokenText(speak: ReturnType<typeof vi.fn>): string {
  const call = speak.mock.calls[0];
  expect(call).toBeDefined();
  return (call?.[0] as SpeakSequencedOptions).text;
}

describe("runWrapper argument handling", () => {
  it("should_write_usage_and_exit_nonzero_when_double_dash_missing", async () => {
    const { deps, spawn } = makeHarness();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runWrapper(["cursor-agent", "chat"], deps);
    expect(code).not.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });

  it("should_error_when_double_dash_has_no_command_after_it", async () => {
    const { deps, spawn } = makeHarness();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runWrapper(["--"], deps);
    expect(code).not.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("should_reject_an_unsupported_stream_format", async () => {
    const { deps, spawn } = makeHarness();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const code = await runWrapper(
      ["--announce-stream", "banana", "--", "agy"],
      deps,
    );
    expect(code).not.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("should_pass_the_argv_after_double_dash_verbatim_with_no_shell", async () => {
    configureGlobal();
    const { deps, spawn, child } = makeHarness();
    const promise = runWrapper(["--", "agy", "--flag", "value with spaces"], deps);
    expect(spawn).toHaveBeenCalledWith(
      "agy",
      ["--flag", "value with spaces"],
      "inherit",
    );
    child().exit(0);
    await promise;
  });
});

describe("runWrapper plain mode exit mapping", () => {
  it("should_emit_done_and_return_0_when_child_exits_0", async () => {
    configureGlobal();
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(["--", "agy"], deps);
    child().exit(0);
    const code = await promise;
    expect(code).toBe(0);
    expect(spokenText(speak)).toBe("agy response is ready in my app");
    const logLine = readFileSync(join(hollrHomeDir, "events.log"), "utf8").trim();
    expect(logLine).toContain("wrapper done my app");
  });

  it("should_emit_error_and_passthrough_nonzero_exit_code", async () => {
    // The default `error` mode is `notify`, so this asserts the notify path,
    // not speak — the point is exit-code passthrough + error line + no crash.
    configureGlobal();
    const { deps, notify, child } = makeHarness();
    const promise = runWrapper(["--", "cursor-agent"], deps);
    child().exit(3);
    const code = await promise;
    expect(code).toBe(3);
    const body = (notify.mock.calls[0]?.[0] as string[] | undefined)?.[2];
    expect(body).toBe("cursor-agent hit an error in my app");
  });

  it("should_use_basename_of_command_as_agent_title", async () => {
    configureGlobal();
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(["--", "/usr/local/bin/agy", "run"], deps);
    child().exit(0);
    await promise;
    expect(spokenText(speak)).toBe("agy response is ready in my app");
  });

  it("should_not_fire_local_sinks_when_muted", async () => {
    configureGlobal();
    const projects = join(hollrHomeDir, "projects");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${encodeCwd(CWD)}.muted`), "");
    const { deps, speak, notify, child } = makeHarness();
    const promise = runWrapper(["--", "agy"], deps);
    child().exit(0);
    const code = await promise;
    expect(code).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("runWrapper stream mode", () => {
  it("should_spawn_in_stream_mode_when_announce_stream_cursor", async () => {
    configureGlobal();
    const { deps, spawn, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent", "-p", "hi"],
      deps,
    );
    expect(spawn).toHaveBeenCalledWith(
      "cursor-agent",
      ["-p", "hi"],
      "stream",
    );
    child().endStdout();
    child().exit(0);
    await promise;
  });

  it("should_read_aloud_the_cursor_result_text_from_ndjson", async () => {
    configureGlobal({ events: { done: { mode: "readaloud" } } });
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().pushStdout(fixture);
    child().endStdout();
    child().exit(0);
    await promise;
    expect(spokenText(speak)).toBe("The answer is 42.");
  });

  it("should_capture_result_across_chunk_boundaries", async () => {
    configureGlobal({ events: { done: { mode: "readaloud" } } });
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    const mid = Math.floor(fixture.length / 2);
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().pushStdout(fixture.slice(0, mid));
    child().pushStdout(fixture.slice(mid));
    child().endStdout();
    child().exit(0);
    await promise;
    expect(spokenText(speak)).toBe("The answer is 42.");
  });

  it("should_tee_child_stdout_to_the_terminal", async () => {
    configureGlobal();
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    const { deps, out, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().pushStdout(fixture);
    child().endStdout();
    child().exit(0);
    await promise;
    const teed = out.mock.calls.map((call) => call[0] as string).join("");
    expect(teed).toContain("The answer is 42.");
  });

  it("should_fall_back_to_announce_line_when_no_result_event", async () => {
    configureGlobal({ events: { done: { mode: "readaloud" } } });
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().pushStdout('{"type":"assistant","message":{}}\n');
    child().endStdout();
    child().exit(0);
    await promise;
    expect(spokenText(speak)).toBe("cursor-agent response is ready in my app");
  });

  it("should_capture_result_that_arrives_after_exit_but_before_stdout_end", async () => {
    // Regression: the child may fire `exit` before stdout is fully drained.
    // Emitting must wait for the stream `end` so the result line is captured,
    // not read null and fall back to the announce line.
    configureGlobal({ events: { done: { mode: "readaloud" } } });
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().exit(0); // exits before the result-bearing chunk is processed
    child().pushStdout(fixture); // result arrives after exit
    child().endStdout(); // drain complete -> emit runs now
    await promise;
    expect(spokenText(speak)).toBe("The answer is 42.");
  });

  it("should_decode_multibyte_utf8_split_across_a_chunk_boundary", async () => {
    // A 4-byte emoji split mid-sequence across two chunks must decode intact,
    // not degrade into U+FFFD replacement characters.
    configureGlobal({ events: { done: { mode: "readaloud" } } });
    const { deps, speak, child } = makeHarness();
    const line = `${JSON.stringify({ type: "result", result: "Hi 😀 there" })}\n`;
    const bytes = Buffer.from(line, "utf8");
    const emojiStart = bytes.indexOf(0xf0); // first byte of 😀 (F0 9F 98 80)
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().pushStdoutBytes(bytes.subarray(0, emojiStart + 1)); // splits the emoji
    child().pushStdoutBytes(bytes.subarray(emojiStart + 1));
    child().endStdout();
    child().exit(0);
    await promise;
    expect(spokenText(speak)).toBe("Hi 😀 there");
  });

  it("should_speak_the_announce_line_not_the_transcript_when_mode_is_announce", async () => {
    // announce mode never reads the transcript aloud even when one is captured.
    configureGlobal({ events: { done: { mode: "announce" } } });
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    const { deps, speak, child } = makeHarness();
    const promise = runWrapper(
      ["--announce-stream", "cursor", "--", "cursor-agent"],
      deps,
    );
    child().pushStdout(fixture);
    child().endStdout();
    child().exit(0);
    await promise;
    expect(spokenText(speak)).toBe("cursor-agent response is ready in my app");
  });
});

describe("runWrapper exit-code passthrough under failure", () => {
  it("should_return_the_child_exit_code_when_a_sink_throws", async () => {
    // The child's exit code is sacred: a throwing sink must not crash the
    // wrapper or change the passthrough code.
    configureGlobal();
    const { deps, child } = makeHarness();
    deps.notify = (): void => {
      throw new Error("sink boom");
    };
    const promise = runWrapper(["--", "cursor-agent"], deps);
    child().exit(3); // exit 3 -> error event -> notify sink throws
    const code = await promise;
    expect(code).toBe(3);
  });
});
