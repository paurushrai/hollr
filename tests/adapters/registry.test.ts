import { describe, expect, it } from "vitest";

import type { DetectableAgent } from "../../src/core/doctor.ts";
import { adapters, byId } from "../../src/adapters/registry.ts";

describe("adapters registry", () => {
  it("should_start_empty_until_concrete_adapters_land", () => {
    expect(adapters).toEqual([]);
  });

  it("should_return_undefined_for_an_unknown_id", () => {
    expect(byId("no-such-agent")).toBeUndefined();
  });

  it("should_be_structurally_usable_as_doctor_detectable_agents", () => {
    // Compile-time contract: the registry can be passed where the doctor
    // expects DetectableAgent[]. This assignment is the assertion.
    const detectable: DetectableAgent[] = adapters;
    expect(detectable).toEqual([]);
  });
});
