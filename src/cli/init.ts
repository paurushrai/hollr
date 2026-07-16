/**
 * The thin shell for `kelbrin init` / `kelbrin uninstall`: the ONLY place @clack is
 * allowed. It builds a real {@link InitIo} from @clack prompts (mapping each
 * cancel to a thrown error so an aborted setup surfaces, not silently succeeds),
 * assembles the real effects (v1 detection, migration, voice enumeration via a
 * spawned process, doctor auto-fix), and delegates to the pure steps.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as clack from "@clack/prompts";

import { adapters } from "../adapters/registry.ts";
import { migrateV1 } from "../core/config.ts";
import type { Platform } from "../platform/index.ts";
import { selectPlatform, whichOnPath } from "../platform/index.ts";
import type { InitChoice, InitDeps, InitIo } from "./init-steps.ts";
import { runInit } from "./init-steps.ts";
import { runUninstall } from "./uninstall.ts";

const EXIT_OK = 0;
const CANCEL_MESSAGE = "Setup cancelled.";
const V1_CONFIG = [".claude", "hollr", "config.json"] as const;

/** Reject a cancelled prompt: the interactive command must surface, not hide. */
function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel(CANCEL_MESSAGE);
    throw new Error(CANCEL_MESSAGE);
  }
  return value;
}

/**
 * Map our choice shape onto @clack's `Option`. Values are widened to `string`
 * so @clack's conditional `Option<Value>` resolves to its primitive branch
 * (a generic `T` leaves it deferred and unassignable); the caller narrows back.
 */
function toClackOptions<T extends string>(
  options: InitChoice<T>[],
): { value: string; label: string; hint?: string }[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.hint === undefined ? {} : { hint: option.hint }),
  }));
}

/** The production io: every prompt is a @clack prompt, cancel throws. */
function clackIo(): InitIo {
  return {
    async multiselect(opts) {
      const chosen = unwrap(
        await clack.multiselect<string>({
          message: opts.message,
          options: toClackOptions(opts.options),
          ...(opts.initialValues === undefined ? {} : { initialValues: opts.initialValues }),
          required: opts.required ?? false,
        }),
      );
      return chosen as (typeof opts.options)[number]["value"][];
    },
    async select(opts) {
      const chosen = unwrap(
        await clack.select<string>({
          message: opts.message,
          options: toClackOptions(opts.options),
          ...(opts.initialValue === undefined ? {} : { initialValue: opts.initialValue }),
        }),
      );
      return chosen as (typeof opts.options)[number]["value"];
    },
    async text(opts) {
      return unwrap(
        await clack.text({
          message: opts.message,
          ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
          ...(opts.initialValue === undefined ? {} : { initialValue: opts.initialValue }),
        }),
      );
    },
    async confirm(opts) {
      return unwrap(
        await clack.confirm({
          message: opts.message,
          initialValue: opts.initialValue ?? false,
        }),
      );
    },
    note(message, title) {
      clack.note(message, title);
    },
  };
}

/** List installed TTS voices by spawning the platform's enumeration argv once. */
function enumerateVoices(platform: Platform): string[] {
  const argv = platform.enumerateVoicesArgv();
  const command = argv?.[0];
  if (argv === null || command === undefined) {
    return [];
  }
  const result = spawnSync(command, argv.slice(1), { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return platform.parseVoicesOutput(result.stdout);
}

/** Run a doctor fix command (argv-split, no shell) — only `xcode-select --install`. */
function autoRunFix(command: string): void {
  const parts = command.split(" ");
  const bin = parts[0];
  if (bin === undefined) {
    return;
  }
  spawnSync(bin, parts.slice(1), { stdio: "inherit" });
}

function realInitDeps(): InitDeps {
  const platform = selectPlatform();
  return {
    io: clackIo(),
    adapters,
    platform,
    home: homedir(),
    which: whichOnPath,
    detectV1: () => existsSync(join(homedir(), ...V1_CONFIG)),
    migrate: migrateV1,
    enumerateVoices: () => enumerateVoices(platform),
    autoRunFix,
  };
}

/**
 * `kelbrin init` shell. `runTestFn` (injected by the dispatcher, which owns the
 * live test deps) runs `kelbrin test` when the user opts into a preview.
 */
export async function runInitCli(
  argv: string[],
  runTestFn: () => Promise<number>,
): Promise<number> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  clack.intro("kelbrin setup");
  const result = await runInit(realInitDeps(), { yes });
  if (result.configPath === null) {
    clack.outro("Setup stopped — nothing was written.");
    return EXIT_OK;
  }
  clack.outro(`Wrote ${result.configPath}`);
  if (result.runTest) {
    await runTestFn();
  }
  return EXIT_OK;
}

/** `kelbrin uninstall` shell. */
export function runUninstallCli(): Promise<number> {
  clack.intro("kelbrin uninstall");
  return runUninstall(clackIo(), { home: homedir(), which: whichOnPath });
}
