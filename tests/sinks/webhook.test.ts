import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookTarget } from "../../src/core/config.ts";
import type { HollrEvent } from "../../src/core/events.ts";
import { fireWebhooks, hardenConfig, webhookPayload } from "../../src/sinks/webhook.ts";

const CWD_SENTINEL = "/secret/path/SENTINEL_CWD_ZZZ";
const RESP_SENTINEL = "SENTINEL_RESPONSE_secret_code_xyz";
const TS = "2026-07-11T12:00:00.000Z";

let tmpRoot: string;
let hollrHomeDir: string;
let logPath: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-wh-"));
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  mkdirSync(hollrHomeDir, { recursive: true });
  logPath = join(hollrHomeDir, "webhook.log");
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
  vi.useRealTimers();
});

function makeEvent(overrides: Partial<HollrEvent> = {}): HollrEvent {
  return {
    v: 1,
    ts: TS,
    agent: "claude-code",
    agentTitle: "Claude Code",
    event: "done",
    cwd: CWD_SENTINEL,
    project: "my app",
    summary: "build passed",
    lastResponse: RESP_SENTINEL,
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FetchRecorder {
  fn: typeof fetch;
  calls: FetchCall[];
}

function recordingFetch(status = 200): FetchRecorder {
  const calls: FetchCall[] = [];
  const fn = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response("", { status }));
  }) as typeof fetch;
  return { fn, calls };
}

function rejectingFetch(): FetchRecorder {
  const calls: FetchCall[] = [];
  const fn = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.reject(new Error("boom"));
  }) as typeof fetch;
  return { fn, calls };
}

function target(overrides: Partial<WebhookTarget> = {}): WebhookTarget {
  return {
    name: "t1",
    provider: "generic",
    url: "https://hook.example/endpoint",
    events: ["done", "blocked", "error"],
    ...overrides,
  };
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): string {
  return typeof call.init.body === "string" ? call.init.body : "";
}

describe("webhookPayload (privacy boundary serializer)", () => {
  it("should_emit_only_the_six_metadata_fields", () => {
    const payload = webhookPayload(makeEvent());
    expect(Object.keys(payload).sort()).toEqual(
      ["agent", "event", "project", "summary", "ts", "v"].sort(),
    );
    expect(payload).toEqual({
      v: 1,
      ts: TS,
      agent: "claude-code",
      event: "done",
      project: "my app",
      summary: "build passed",
    });
  });

  it("should_never_include_cwd_or_last_response", () => {
    const serialized = JSON.stringify(webhookPayload(makeEvent()));
    expect(serialized).not.toContain(CWD_SENTINEL);
    expect(serialized).not.toContain(RESP_SENTINEL);
  });
});

const ALL_PROVIDERS: WebhookTarget["provider"][] = [
  "ntfy",
  "pushover",
  "slack",
  "generic",
];

describe("privacy headline — no cwd/lastResponse leaks for any provider", () => {
  it("should_not_leak_sentinels_in_body_or_headers_for_every_provider", async () => {
    for (const provider of ALL_PROVIDERS) {
      const { fn, calls } = recordingFetch();
      await fireWebhooks(
        makeEvent(),
        [
          target({
            provider,
            headers: { token: "abc", user: "def", "X-Extra": "v" },
          }),
        ],
        { allowHttp: false, fetchFn: fn, logPath },
      );
      expect(calls).toHaveLength(1);
      const combined = bodyOf(calls[0]!) + JSON.stringify(headersOf(calls[0]!));
      expect(combined, `${provider} leaked cwd`).not.toContain(CWD_SENTINEL);
      expect(combined, `${provider} leaked response`).not.toContain(RESP_SENTINEL);
    }
  });
});

describe("provider formatting", () => {
  it("should_format_ntfy_with_summary_body_title_and_priority", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ provider: "ntfy", headers: { "X-Custom": "y" } })],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    const call = calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(bodyOf(call)).toBe("build passed");
    const headers = headersOf(call);
    expect(headers.Title).toBe("hollr: Claude Code done in my app");
    expect(headers.Priority).toBe("default");
    expect(headers["X-Custom"]).toBe("y");
  });

  it("should_use_high_priority_for_non_done_ntfy_events", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(makeEvent({ event: "error" }), [target({ provider: "ntfy" })], {
      allowHttp: false,
      fetchFn: fn,
      logPath,
    });
    expect(headersOf(calls[0]!).Priority).toBe("high");
  });

  it("should_move_pushover_token_and_user_into_form_fields_not_headers", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ provider: "pushover", headers: { token: "TKN", user: "USR" } })],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    const call = calls[0]!;
    const params = new URLSearchParams(bodyOf(call));
    expect(params.get("token")).toBe("TKN");
    expect(params.get("user")).toBe("USR");
    expect(params.get("title")).toBe("hollr: Claude Code done in my app");
    expect(params.get("message")).toBe("build passed");
    const headers = headersOf(call);
    expect(headers.token).toBeUndefined();
    expect(headers.user).toBeUndefined();
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("should_format_slack_as_json_text", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(makeEvent(), [target({ provider: "slack" })], {
      allowHttp: false,
      fetchFn: fn,
      logPath,
    });
    const call = calls[0]!;
    expect(headersOf(call)["content-type"]).toBe("application/json");
    expect(JSON.parse(bodyOf(call))).toEqual({
      text: "hollr: Claude Code done in my app — build passed",
    });
  });

  it("should_format_generic_as_webhook_payload_json", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ provider: "generic", headers: { "X-Api": "k" } })],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    const call = calls[0]!;
    expect(headersOf(call)["content-type"]).toBe("application/json");
    expect(headersOf(call)["X-Api"]).toBe("k");
    expect(JSON.parse(bodyOf(call))).toEqual(webhookPayload(makeEvent()));
  });
});

describe("delivery semantics", () => {
  it("should_only_fire_targets_whose_events_include_the_event", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent({ event: "error" }),
      [
        target({ name: "done-only", events: ["done"] }),
        target({ name: "error-ok", events: ["error"] }),
      ],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    expect(calls).toHaveLength(1);
    expect(readFileSync(logPath, "utf8")).toContain("error-ok");
  });

  it("should_not_retry_on_http_error_and_log_status_and_name", async () => {
    const { fn, calls } = recordingFetch(500);
    await fireWebhooks(makeEvent(), [target({ name: "srv" })], {
      allowHttp: false,
      fetchFn: fn,
      logPath,
    });
    expect(calls).toHaveLength(1);
    expect(readFileSync(logPath, "utf8")).toContain("500 srv");
  });

  it("should_retry_once_on_network_error_then_log_failure", async () => {
    const { fn, calls } = rejectingFetch();
    await fireWebhooks(makeEvent(), [target({ name: "net" })], {
      allowHttp: false,
      fetchFn: fn,
      logPath,
    });
    expect(calls).toHaveLength(2);
    expect(readFileSync(logPath, "utf8")).toContain("error net");
  });

  it("should_abort_after_timeout_and_retry_once", async () => {
    vi.useFakeTimers();
    let aborts = 0;
    const calls: FetchCall[] = [];
    const fn = ((url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          aborts += 1;
          reject(new Error("aborted"));
        });
      });
    }) as typeof fetch;
    const promise = fireWebhooks(makeEvent(), [target({ name: "slow" })], {
      allowHttp: false,
      fetchFn: fn,
      logPath,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(aborts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(readFileSync(logPath, "utf8")).toContain("error slow");
  });

  it("should_skip_http_url_when_allowHttp_is_false_and_log_reason", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ name: "insecure", url: "http://hook.example/x" })],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    expect(calls).toHaveLength(0);
    expect(readFileSync(logPath, "utf8")).toContain("http-not-allowed");
  });

  it("should_allow_http_url_when_allowHttp_is_true", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ name: "insecure", url: "http://hook.example/x" })],
      { allowHttp: true, fetchFn: fn, logPath },
    );
    expect(calls).toHaveLength(1);
  });

  it("should_always_allow_https", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(makeEvent(), [target({ url: "https://hook.example/y" })], {
      allowHttp: false,
      fetchFn: fn,
      logPath,
    });
    expect(calls).toHaveLength(1);
  });

  it("should_allow_http_when_the_target_opts_in_even_if_the_global_flag_is_false", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ name: "opted-in", url: "http://hook.example/x", allowHttp: true })],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    expect(calls).toHaveLength(1);
  });

  it("should_not_let_one_target_http_opt_in_bleed_into_a_sibling_http_target", async () => {
    const { fn, calls } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [
        target({ name: "opted-in", url: "http://a.example/x", allowHttp: true }),
        target({ name: "not-opted", url: "http://b.example/x" }),
      ],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    // Only the opted-in target is delivered; the sibling is skipped, not widened.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://a.example/x");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("not-opted http-not-allowed");
  });

  it("should_never_reject_even_when_delivery_fails", async () => {
    const { fn } = rejectingFetch();
    await expect(
      fireWebhooks(makeEvent(), [target()], { allowHttp: false, fetchFn: fn, logPath }),
    ).resolves.toBeUndefined();
  });

  it("should_rotate_log_to_last_100_lines", async () => {
    const seed = Array.from({ length: 100 }, (_v, i) => `old-${i}`).join("\n");
    writeFileSync(logPath, `${seed}\n`);
    const { fn } = recordingFetch();
    await fireWebhooks(
      makeEvent(),
      [target({ name: "a" }), target({ name: "b" }), target({ name: "c" })],
      { allowHttp: false, fetchFn: fn, logPath },
    );
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[lines.length - 1]).toContain("c");
    expect(readFileSync(logPath, "utf8")).not.toContain("old-0\n");
  });
});

describe("malformed config resilience (never reject, isolate targets)", () => {
  it("should_skip_unknown_provider_and_still_deliver_valid_sibling", async () => {
    const { fn, calls } = recordingFetch();
    const bad = target({ name: "tg", url: "https://hook.example/tg" });
    // Simulate a hand-edited config with a provider outside the known keys.
    (bad as { provider: string }).provider = "telegram";
    await expect(
      fireWebhooks(makeEvent(), [bad, target({ name: "ok" })], {
        allowHttp: false,
        fetchFn: fn,
        logPath,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hook.example/endpoint");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("ok");
    expect(log).toContain("skip tg unknown-provider");
  });

  it("should_skip_target_with_non_array_events_without_throwing", async () => {
    const { fn, calls } = recordingFetch();
    const bad = target({ name: "bad-events" });
    (bad as { events: unknown }).events = "done";
    await expect(
      fireWebhooks(makeEvent(), [bad, target({ name: "ok" })], {
        allowHttp: false,
        fetchFn: fn,
        logPath,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hook.example/endpoint");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("ok");
    expect(log).not.toContain("bad-events");
  });

  it("should_skip_target_with_missing_events_without_throwing", async () => {
    const { fn, calls } = recordingFetch();
    const bad = target({ name: "no-events" });
    delete (bad as { events?: unknown }).events;
    await expect(
      fireWebhooks(makeEvent(), [bad, target({ name: "ok" })], {
        allowHttp: false,
        fetchFn: fn,
        logPath,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("hardenConfig", () => {
  it("should_chmod_config_to_600_when_a_target_has_headers", () => {
    const cfgPath = join(hollrHomeDir, "config.json");
    writeFileSync(cfgPath, "{}");
    chmodSync(cfgPath, 0o644);
    hardenConfig([target({ headers: { token: "x" } })]);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  it("should_not_chmod_when_no_target_has_headers", () => {
    const cfgPath = join(hollrHomeDir, "config.json");
    writeFileSync(cfgPath, "{}");
    chmodSync(cfgPath, 0o644);
    hardenConfig([target()]);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o644);
  });
});
