import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pruneReadaloudDir } from "../../src/core/prune.ts";

let dir: string;
const NOW = new Date("2026-07-12T12:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hollr-prune-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ageFile(name: string, hoursAgo: number): string {
  const p = join(dir, name);
  writeFileSync(p, "x");
  const t = new Date(NOW.getTime() - hoursAgo * 3600_000);
  utimesSync(p, t, t);
  return p;
}

describe("pruneReadaloudDir", () => {
  it("should_delete_files_older_than_the_ttl_and_keep_fresh_ones", () => {
    ageFile("old.md", 30);
    ageFile("fresh.md", 1);
    pruneReadaloudDir(dir, NOW);
    expect(readdirSync(dir).sort()).toEqual(["fresh.md"]);
  });

  it("should_never_throw_on_a_missing_directory", () => {
    expect(() => pruneReadaloudDir(join(dir, "nope"), NOW)).not.toThrow();
  });
});
