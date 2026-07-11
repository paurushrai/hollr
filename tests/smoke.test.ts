import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION, getVersionString } from "../src/index.ts";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };
const EXPECTED_VERSION = packageJson.version;
const EXPECTED_BANNER = `hollr ${EXPECTED_VERSION}`;

describe("version stub", () => {
  it("should_expose_the_package_json_version", () => {
    expect(VERSION).toBe(EXPECTED_VERSION);
  });

  it("should_format_banner_as_hollr_space_version", () => {
    expect(getVersionString()).toBe(EXPECTED_BANNER);
  });
});
