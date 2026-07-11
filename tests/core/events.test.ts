import { describe, expect, it } from "vitest";

import { prepareSpeechText, projectLabel } from "../../src/core/events.ts";

describe("projectLabel", () => {
  it("should_use_basename_with_dashes_as_spaces", () => {
    expect(projectLabel("/Users/me/dev/my-app")).toBe("my app");
  });

  it("should_turn_underscores_into_spaces", () => {
    expect(projectLabel("/Users/me/dev/my_cool_app")).toBe("my cool app");
  });

  it("should_ignore_a_trailing_slash", () => {
    expect(projectLabel("/Users/me/dev/proj/")).toBe("proj");
  });

  it("should_fall_back_to_the_original_when_basename_is_empty", () => {
    expect(projectLabel("/")).toBe("/");
  });
});

describe("prepareSpeechText", () => {
  it("should_replace_fenced_code_blocks_with_placeholder_when_stripping", () => {
    const input = "before ```js\nconst x = 1;\n``` after";
    expect(prepareSpeechText(input, 1200, true)).toBe(
      "before code block omitted. after",
    );
  });

  it("should_strip_stray_backticks_when_stripping", () => {
    expect(prepareSpeechText("use `foo` now", 1200, true)).toBe("use foo now");
  });

  it("should_collapse_whitespace_runs_to_single_spaces", () => {
    expect(prepareSpeechText("a\n\n  b\t c", 1200, true)).toBe("a b c");
  });

  it("should_cap_output_to_max_chars", () => {
    expect(prepareSpeechText("abcdef", 3, true)).toBe("abc");
  });

  it("should_leave_code_and_backticks_when_not_stripping", () => {
    const input = "keep `x` and ```y```";
    const result = prepareSpeechText(input, 1200, false);
    expect(result).toContain("`x`");
    expect(result).toContain("```y```");
  });

  it("should_still_collapse_whitespace_when_not_stripping", () => {
    expect(prepareSpeechText("a   b", 1200, false)).toBe("a b");
  });
});
