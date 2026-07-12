import { describe, expect, it } from "vitest";

import type { DetectableAgent } from "../../src/core/doctor.ts";
import { adapters, byId } from "../../src/adapters/registry.ts";

describe("adapters registry", () => {
  it("should_register_the_claude_code_reference_adapter", () => {
    expect(adapters.map((adapter) => adapter.id)).toContain("claude-code");
  });

  it("should_resolve_a_registered_adapter_by_id", () => {
    expect(byId("claude-code")?.title).toBe("Claude Code");
  });

  it("should_return_undefined_for_an_unknown_id", () => {
    expect(byId("no-such-agent")).toBeUndefined();
  });

  it("should_be_structurally_usable_as_doctor_detectable_agents", () => {
    // Compile-time contract: the registry can be passed where the doctor
    // expects DetectableAgent[]. This assignment is the assertion.
    const detectable: DetectableAgent[] = adapters;
    expect(detectable.length).toBeGreaterThan(0);
  });
});

describe("instructionInjection capability contract", () => {
  it("should_declare_the_capability_on_every_adapter", () => {
    for (const a of adapters) {
      expect(typeof a.capabilities.instructionInjection).toBe("boolean");
    }
  });

  it("should_expose_memoryPath_iff_capable", () => {
    const deps = { home: "/home/u", which: () => null };
    for (const a of adapters) {
      if (a.capabilities.instructionInjection) {
        expect(typeof a.memoryPath).toBe("function");
        expect(a.memoryPath?.(deps).length).toBeGreaterThan(0);
      } else {
        expect(a.memoryPath).toBeUndefined();
      }
    }
  });
});
