import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildReadaloudBlock,
  injectReadaloud,
  readaloudLedgerKey,
} from "../../src/adapters/instruction.ts";

let tmpRoot: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-instr-"));
  prevHollrHome = process.env.HOLLR_HOME;
  process.env.HOLLR_HOME = join(tmpRoot, ".config", "hollr");
});

afterEach(() => {
  if (prevHollrHome === undefined) delete process.env.HOLLR_HOME;
  else process.env.HOLLR_HOME = prevHollrHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildReadaloudBlock", () => {
  it("should_embed_the_open_command_and_temp_dir_and_the_guardrail", () => {
    const block = buildReadaloudBlock("open");
    expect(block).toContain("read aloud");
    expect(block).toContain("open"); // open command
    expect(block).toContain("readaloud"); // temp dir path segment
    expect(block.toUpperCase()).toContain("INTENTIONAL"); // don't over-dump guardrail
  });
});

describe("injectReadaloud", () => {
  it("should_write_a_reversible_block_into_the_memory_file", () => {
    const path = join(tmpRoot, "CLAUDE.md");
    writeFileSync(path, "# mine\n");
    const op = injectReadaloud(path, "open", "claude-code");
    expect(op.changed).toBe(true);
    op.apply();
    const out = readFileSync(path, "utf8");
    expect(out).toContain("# mine");
    expect(out).toContain("hollr:readaloud:start");
  });
});

describe("readaloudLedgerKey", () => {
  it("should_namespace_by_adapter_id", () => {
    expect(readaloudLedgerKey("codex")).toBe("codex:readaloud");
  });
});
