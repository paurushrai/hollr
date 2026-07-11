import { describe, expect, it } from "vitest";
import { VERSION, getVersionString, run } from "../src/index.ts";

const EXPECTED_BANNER = "hollr 0.2.0";

describe("version stub", () => {
  it("should_expose_version_0_2_0", () => {
    expect(VERSION).toBe("0.2.0");
  });

  it("should_format_banner_as_hollr_space_version", () => {
    expect(getVersionString()).toBe(EXPECTED_BANNER);
  });

  it("should_print_version_banner_when_version_flag_passed", () => {
    expect(run(["--version"])).toBe(EXPECTED_BANNER);
    expect(run(["-v"])).toBe(EXPECTED_BANNER);
  });

  it("should_print_version_banner_when_no_args_passed", () => {
    expect(run([])).toBe(EXPECTED_BANNER);
  });
});
