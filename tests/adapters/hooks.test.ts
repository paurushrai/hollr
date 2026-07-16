import { describe, expect, it } from "vitest";
import { removeKelbrinHooks } from "../../src/adapters/hooks.ts";

const isNested = (e: unknown): boolean =>
  typeof e === "object" && e !== null && Array.isArray((e as { hooks?: unknown[] }).hooks) &&
  (e as { hooks: { command?: string }[] }).hooks.some((h) => h?.command === "CMD");

describe("removeKelbrinHooks", () => {
  it("should_remove_only_matching_entries_and_preserve_foreign_ones", () => {
    const json = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "CMD" }] }, { hooks: [{ command: "USER" }] }],
        PreToolUse: [{ hooks: [{ command: "USER2" }] }],
      },
    };
    const out = removeKelbrinHooks(json, ["Stop"], isNested);
    expect(out.hooks).toEqual({
      Stop: [{ hooks: [{ command: "USER" }] }],
      PreToolUse: [{ hooks: [{ command: "USER2" }] }],
    });
  });

  it("should_drop_an_emptied_event_key_and_emptied_hooks_object", () => {
    const json = { hooks: { Stop: [{ hooks: [{ command: "CMD" }] }] }, other: 1 };
    const out = removeKelbrinHooks(json, ["Stop"], isNested);
    expect(out).toEqual({ other: 1 }); // hooks fully gone
  });

  it("should_be_inert_when_hooks_is_absent_or_not_an_object", () => {
    expect(removeKelbrinHooks({ a: 1 }, ["Stop"], isNested)).toEqual({ a: 1 });
  });
});
