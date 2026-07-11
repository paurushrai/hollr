import { describe, expect, it, vi } from "vitest";

import { isEntryModule } from "../src/index.ts";

const MODULE = "/pkg/lib/node_modules/hollr/dist/index.js";
const SYMLINK = "/usr/local/bin/hollr";

describe("isEntryModule", () => {
  it("should_return_false_when_entry_is_undefined", () => {
    const resolve = vi.fn((path: string) => path);
    expect(isEntryModule(undefined, MODULE, resolve)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("should_return_true_on_direct_path_match_without_resolving", () => {
    const resolve = vi.fn((path: string) => path);
    expect(isEntryModule(MODULE, MODULE, resolve)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("should_return_true_when_entry_is_a_symlink_resolving_to_the_module", () => {
    const resolve = vi.fn((path: string) => (path === SYMLINK ? MODULE : path));
    expect(isEntryModule(SYMLINK, MODULE, resolve)).toBe(true);
    expect(resolve).toHaveBeenCalledWith(SYMLINK);
  });

  it("should_return_false_when_a_resolved_entry_points_elsewhere", () => {
    const resolve = vi.fn(() => "/some/other/script.js");
    expect(isEntryModule("/some/other/script.js-link", MODULE, resolve)).toBe(
      false,
    );
  });

  it("should_return_false_when_resolve_throws", () => {
    const resolve = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(isEntryModule(SYMLINK, MODULE, resolve)).toBe(false);
  });
});
