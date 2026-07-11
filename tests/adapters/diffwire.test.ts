import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  unwireFromLedger,
  wireJsonFile,
  wireTextFile,
} from "../../src/adapters/diffwire.ts";

interface LedgerEntry {
  ledgerKey: string;
  path: string;
  before: string | null;
  at: string;
}

let tmpRoot: string;
let hollrHomeDir: string;
let prevHollrHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hollr-wire-"));
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
});

function target(name: string): string {
  return join(tmpRoot, name);
}

function readLedger(): LedgerEntry[] {
  const raw = readFileSync(join(hollrHomeDir, "wired.json"), "utf8");
  return JSON.parse(raw) as LedgerEntry[];
}

const IDENTITY = (json: Record<string, unknown>): Record<string, unknown> => json;

const ADD_HOOK = (json: Record<string, unknown>): Record<string, unknown> => ({
  ...json,
  hook: "hollr emit",
});

describe("wireJsonFile", () => {
  it("should_report_change_and_render_added_lines_when_file_absent", () => {
    const path = target("config.json");
    const op = wireJsonFile(path, ADD_HOOK, "cc-settings");
    expect(op.changed).toBe(true);
    expect(op.diff).toContain('+  "hook": "hollr emit"');
    expect(existsSync(path)).toBe(false); // not written until apply()
  });

  it("should_write_canonical_json_and_record_absent_before_on_apply", () => {
    const path = target("config.json");
    const op = wireJsonFile(path, ADD_HOOK, "cc-settings");
    op.apply();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hook: "hollr emit" });
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
    const ledger = readLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.ledgerKey).toBe("cc-settings");
    expect(ledger[0]?.before).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "should_write_the_ledger_owner_only_0600_since_it_copies_foreign_secrets",
    () => {
      const path = target("config.json");
      wireJsonFile(path, ADD_HOOK, "cc-settings").apply();
      const mode = statSync(join(hollrHomeDir, "wired.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it("should_be_idempotent_on_second_wire_with_no_diff", () => {
    const path = target("config.json");
    wireJsonFile(path, ADD_HOOK, "cc-settings").apply();
    const second = wireJsonFile(path, ADD_HOOK, "cc-settings");
    expect(second.changed).toBe(false);
    expect(second.diff).toBe("");
  });

  it("should_merge_into_existing_json_preserving_prior_keys", () => {
    const path = target("config.json");
    writeFileSync(path, `${JSON.stringify({ existing: 1 }, null, 2)}\n`);
    const op = wireJsonFile(path, ADD_HOOK, "cc-settings");
    op.apply();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      existing: 1,
      hook: "hollr emit",
    });
  });

  it("should_treat_a_no_op_mutate_on_existing_file_as_unchanged", () => {
    const path = target("config.json");
    writeFileSync(path, `${JSON.stringify({ existing: 1 }, null, 2)}\n`);
    const op = wireJsonFile(path, IDENTITY, "cc-settings");
    expect(op.changed).toBe(false);
    expect(op.diff).toBe("");
  });
});

describe("wireTextFile", () => {
  it("should_render_a_line_diff_of_old_vs_new", () => {
    const path = target("hollr.md");
    writeFileSync(path, "line one\nline two\nline three\n");
    const op = wireTextFile(path, "line one\nCHANGED\nline three\n", "cc-md");
    expect(op.changed).toBe(true);
    expect(op.diff).toContain("-line two");
    expect(op.diff).toContain("+CHANGED");
    expect(op.diff).toContain(" line one"); // context retained
  });

  it("should_be_unchanged_when_new_content_equals_existing", () => {
    const path = target("hollr.md");
    writeFileSync(path, "same\n");
    const op = wireTextFile(path, "same\n", "cc-md");
    expect(op.changed).toBe(false);
    expect(op.diff).toBe("");
  });
});

describe("unwireFromLedger", () => {
  it("should_restore_the_prior_file_byte_identically", () => {
    const path = target("hollr.md");
    const original = "original\nbytes\n";
    writeFileSync(path, original);
    wireTextFile(path, "brand new content\n", "cc-md").apply();
    expect(readFileSync(path, "utf8")).toBe("brand new content\n");
    unwireFromLedger("cc-md");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("should_delete_a_file_that_did_not_exist_before_wiring", () => {
    const path = target("created.json");
    wireJsonFile(path, ADD_HOOK, "cc-settings").apply();
    expect(existsSync(path)).toBe(true);
    unwireFromLedger("cc-settings");
    expect(existsSync(path)).toBe(false);
  });

  it("should_remove_the_ledger_entry_after_reversal", () => {
    const path = target("created.json");
    wireJsonFile(path, ADD_HOOK, "cc-settings").apply();
    expect(readLedger()).toHaveLength(1);
    unwireFromLedger("cc-settings");
    expect(readLedger()).toHaveLength(0);
  });

  it("should_be_a_no_op_for_an_unknown_ledger_key", () => {
    expect(() => unwireFromLedger("never-wired")).not.toThrow();
  });
});

describe("wired.json ledger round-trip", () => {
  it("should_accumulate_one_entry_per_applied_wire", () => {
    wireJsonFile(target("a.json"), ADD_HOOK, "key-a").apply();
    wireTextFile(target("b.md"), "b\n", "key-b").apply();
    const ledger = readLedger();
    expect(ledger.map((entry) => entry.ledgerKey)).toEqual(["key-a", "key-b"]);
    expect(ledger.every((entry) => typeof entry.at === "string")).toBe(true);
  });
});
