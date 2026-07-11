/**
 * `hollr test [--webhook] [--show-payload]`: fire a synthetic "done" event so a
 * user can verify their setup live. It composes existing subsystems and adds NO
 * core logic — the same {@link route} the emit hook uses drives the real local
 * sinks (voice + desktop notify), which is exactly the live check a user does by
 * hand.
 *
 * Unlike `emit`, this is an interactive command: a genuine failure surfaces
 * (propagates to `main`, exit non-zero) rather than degrading to exit 0.
 *
 * All external effects are injected via {@link TestDeps} so the command is unit
 * testable without touching real audio, network, or spawn.
 */

import type { EventName, WebhookTarget } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import type { HollrEvent } from "../core/events.ts";
import { projectLabel } from "../core/events.ts";
import { route } from "../core/router.ts";
import type { Platform } from "../platform/index.ts";
import type { speakSequenced } from "../platform/sequencer.ts";
import { webhookPayload } from "../sinks/webhook.ts";
import { settleWebhooks } from "./emit.ts";

const TEST_AGENT = "hollr-test";
const TEST_TITLE = "hollr";
const TEST_EVENT: EventName = "done";
const TEST_SUMMARY = "hollr test";
const PAYLOAD_INDENT = 2;
const EXIT_OK = 0;

/** Injected effects so `runTest` is unit-testable (no real audio/network/spawn). */
export interface TestDeps {
  /** Working directory the synthetic event targets; also selects the config. */
  cwd: string;
  platform: Platform;
  speak: typeof speakSequenced;
  notify(argv: string[]): void;
  /** Start (do not await) webhook delivery; mirrors the emit sink contract. */
  webhooks(ev: HollrEvent, targets: WebhookTarget[], allowHttp: boolean): void;
  /** Resolve when collected webhook deliveries settle (never rejects). */
  awaitWebhooks(): Promise<void>;
  /** Sink for `--show-payload` output. */
  out(text: string): void;
}

interface TestFlags {
  webhook: boolean;
  showPayload: boolean;
}

function parseTestFlags(args: string[]): TestFlags {
  return {
    webhook: args.includes("--webhook"),
    showPayload: args.includes("--show-payload"),
  };
}

/** The fixed synthetic event: a `done` turn from the pseudo-agent `hollr-test`. */
function buildTestEvent(cwd: string, now: Date): HollrEvent {
  return {
    v: 1,
    ts: now.toISOString(),
    agent: TEST_AGENT,
    agentTitle: TEST_TITLE,
    event: TEST_EVENT,
    cwd,
    project: projectLabel(cwd),
    summary: TEST_SUMMARY,
  };
}

/**
 * Fire the synthetic event. Default: drive the real local sinks (webhooks stay
 * a no-op). `--webhook`: also fire webhooks with the effective config targets.
 * `--show-payload`: print the exact off-machine payload and send nothing — this
 * flag takes precedence.
 */
export async function runTest(
  args: string[],
  deps: TestDeps,
  now: Date,
): Promise<number> {
  const flags = parseTestFlags(args);
  const event = buildTestEvent(deps.cwd, now);
  if (flags.showPayload) {
    deps.out(`${JSON.stringify(webhookPayload(event), null, PAYLOAD_INDENT)}\n`);
    return EXIT_OK;
  }
  const cfg = loadConfig(deps.cwd);
  const code = route(
    event,
    cfg,
    {
      platform: deps.platform,
      speak: deps.speak,
      notify: deps.notify,
      webhooks: (ev) => {
        if (flags.webhook) {
          deps.webhooks(ev, cfg.webhooks, cfg.allowHttp);
        }
      },
    },
    now,
  );
  await settleWebhooks(deps.awaitWebhooks());
  return code;
}
