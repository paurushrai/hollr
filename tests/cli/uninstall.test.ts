import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeCode } from "../../src/adapters/claude-code.ts";
import { listWiredKeys } from "../../src/adapters/diffwire.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";
import type { InitChoice, InitIo } from "../../src/cli/init-steps.ts";
import { runUninstall } from "../../src/cli/uninstall.ts";

let tmpRoot: string;
let home: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

/** `which` fake that resolves nothing (no agent binaries on PATH). */
const whichNone = (): string | null => null;

/** A scripted, side-effect-free io: confirm answers are dequeued in order. */
class ScriptIo implements InitIo {
  confirmQueue: boolean[] = [];
  notes: string[] = [];

  multiselect<T extends string>(): Promise<T[]> {
    throw new Error("not scripted for uninstall");
  }

  select<T extends string>(opts: { options: InitChoice<T>[] }): Promise<T> {
    return Promise.resolve(opts.options[0]?.value as T);
  }

  text(): Promise<string> {
    throw new Error("not scripted for uninstall");
  }

  confirm(): Promise<boolean> {
    const next = this.confirmQueue.shift();
    if (next === undefined) {
      throw new Error("no scripted confirm answer");
    }
    return Promise.resolve(next);
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

function scriptIo(opts: { confirm: boolean[] }): ScriptIo {
  const io = new ScriptIo();
  io.confirmQueue = [...opts.confirm];
  return io;
}

function writeLedger(keys: string[]): void {
  mkdirSync(hollrHomeDir, { recursive: true });
  const entries = keys.map((ledgerKey) => ({
    ledgerKey,
    path: join(home, `${ledgerKey}.json`),
    before: null,
    at: "2026-01-01T00:00:00.000Z",
  }));
  writeFileSync(join(hollrHomeDir, "wired.json"), JSON.stringify(entries));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-uninstall-"));
  home = join(tmpRoot, "home");
  hollrHomeDir = join(tmpRoot, ".config", "hollr");
  mkdirSync(home, { recursive: true });
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
});

describe("runUninstall", () => {
  it("should_unwire_every_key_and_delete_home_on_double_confirm", async () => {
    writeLedger(["a1:cfg", "b2:cfg"]);
    const io = scriptIo({ confirm: [true, true] }); // unwire all, delete home
    const deps: AdapterDeps = { home, which: whichNone };

    const code = await runUninstall(io, deps);

    expect(code).toBe(0);
    expect(() => readFileSync(join(hollrHomeDir, "wired.json"), "utf8")).toThrow();
  });

  it("should_stop_when_the_user_declines_the_first_confirm", async () => {
    writeLedger(["a1:cfg"]);
    const io = scriptIo({ confirm: [false] }); // decline
    const deps: AdapterDeps = { home, which: whichNone };

    const code = await runUninstall(io, deps);

    expect(code).toBe(0);
    const ledger = readFileSync(join(hollrHomeDir, "wired.json"), "utf8");
    expect(ledger).toContain("a1:cfg");
  });

  it("should_uninstall_surgically_preserving_foreign_config", async () => {
    const deps: AdapterDeps = { home, which: whichNone };
    await claudeCode.wire(deps);
    const path = join(home, ".claude", "settings.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    cfg.hooks.Stop.push({ hooks: [{ command: "user-keep" }] });
    writeFileSync(path, JSON.stringify(cfg, null, 2));

    const io = scriptIo({ confirm: [true, false] }); // reverse: yes, delete HOME: no
    await runUninstall(io, deps);

    const out = JSON.parse(readFileSync(path, "utf8"));
    const cmds = (out.hooks?.Stop ?? []).flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds).toEqual(["user-keep"]); // hollr's gone, foreign kept
    expect(listWiredKeys()).toEqual([]);
  });
});
