import { describe, expect, it } from "vitest";
import { VERSION, getVersionString } from "../src/index.ts";

const EXPECTED_BANNER = "hollr 0.2.0";

describe("version stub", () => {
  it("should_expose_version_0_2_0", () => {
    expect(VERSION).toBe("0.2.0");
  });

  it("should_format_banner_as_hollr_space_version", () => {
    expect(getVersionString()).toBe(EXPECTED_BANNER);
  });
});
