import { describe, expect, it } from "vitest";

import { byId } from "../../src/adapters/registry.ts";
import { wrapper } from "../../src/adapters/wrapper.ts";
import type { AdapterDeps } from "../../src/adapters/types.ts";

const deps: AdapterDeps = { home: "/tmp/home", which: () => null };

describe("wrapper pseudo-adapter", () => {
  it("should_be_registered_in_the_registry", () => {
    expect(byId("wrapper")?.title).toBe("Wrapper");
  });

  it("should_always_detect_as_installed", async () => {
    const detection = await wrapper.detect(deps);
    expect(detection.installed).toBe(true);
  });

  it("should_no_op_wire_with_usage_instructions_and_no_change", async () => {
    const result = await wrapper.wire(deps);
    expect(result.changed).toBe(false);
    expect(result.warnings.join(" ")).toContain("hollr run");
  });

  it("should_no_op_unwire", async () => {
    await expect(wrapper.unwire(deps)).resolves.toBeUndefined();
  });

  it("should_decline_normalize_and_read_last_response", async () => {
    expect(wrapper.normalize({}, "done")).toBeNull();
    await expect(wrapper.readLastResponse({})).resolves.toBeNull();
  });

  it("should_advertise_done_and_read_aloud_capabilities", () => {
    expect(wrapper.capabilities.done).toBe(true);
    expect(wrapper.capabilities.readAloud).toBe(true);
    expect(wrapper.capabilities.blocked).toBe(false);
    expect(wrapper.capabilities.slashCommand).toBe(false);
  });
});
