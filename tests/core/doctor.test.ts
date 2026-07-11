import { describe, expect, it } from "vitest";

import {
  allRequiredOk,
  checkAll,
  type Check,
  type DetectableAgent,
} from "../../src/core/doctor.ts";
import { selectPlatform, type Platform } from "../../src/platform/index.ts";

type Which = (bin: string) => string | null;

/** `which` fake resolving only the named binaries to a fake path. */
function whichWith(...present: string[]): Which {
  return (bin) => (present.includes(bin) ? `/usr/bin/${bin}` : null);
}

/** `which` fake that resolves everything (all prerequisites satisfied). */
const whichAll: Which = (bin) => `/usr/bin/${bin}`;

/** `which` fake that resolves nothing (a bare machine). */
const whichNone: Which = () => null;

const NODE_OK = "20.11.0";

function byKey(checks: Check[], key: string): Check | undefined {
  return checks.find((check) => check.key === key);
}

describe("checkAll — Node.js version", () => {
  const platform = selectPlatform("darwin");

  it("should_fail_when_node_major_below_20", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform,
      nodeVersion: "18.19.0",
    });
    const node = byKey(checks, "node");
    expect(node?.label).toBe("Node.js");
    expect(node?.required).toBe(true);
    expect(node?.ok).toBe(false);
    expect(node?.fix).toBeTruthy();
  });

  it("should_pass_at_node_20_boundary", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform,
      nodeVersion: "20.0.0",
    });
    const node = byKey(checks, "node");
    expect(node?.ok).toBe(true);
    expect(node?.fix).toBeNull();
  });

  it("should_pass_above_node_20", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform,
      nodeVersion: "22.4.1",
    });
    expect(byKey(checks, "node")?.ok).toBe(true);
  });

  it("should_not_double_prefix_v_when_version_already_has_v", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform,
      nodeVersion: "v20.1.0",
    });
    const node = byKey(checks, "node");
    expect(node?.ok).toBe(true);
    expect(node?.detail.startsWith("v20.1.0")).toBe(true);
    expect(node?.detail).not.toContain("vv");
  });
});

describe("checkAll — platform binaries", () => {
  it("should_report_darwin_required_and_optional_sets", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
    });
    const say = byKey(checks, "say");
    const afplay = byKey(checks, "afplay");
    expect(say?.required).toBe(true);
    expect(say?.ok).toBe(true);
    expect(say?.detail).toContain("/usr/bin/say");
    expect(byKey(checks, "osascript")?.required).toBe(true);
    expect(afplay?.required).toBe(false);
    expect(allRequiredOk(checks)).toBe(true);
  });

  it("should_report_linux_required_set_with_spd_say_and_notify_send", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("linux"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "spd-say")?.required).toBe(true);
    expect(byKey(checks, "notify-send")?.required).toBe(true);
    expect(byKey(checks, "paplay")?.required).toBe(false);
  });

  it("should_report_win32_required_powershell", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("win32"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "powershell")?.required).toBe(true);
    expect(byKey(checks, "powershell")?.ok).toBe(true);
  });

  it("should_carry_fix_string_on_missing_required_linux_binary", async () => {
    const checks = await checkAll({
      which: whichNone,
      platform: selectPlatform("linux"),
      nodeVersion: NODE_OK,
    });
    const spdSay = byKey(checks, "spd-say");
    expect(spdSay?.ok).toBe(false);
    expect(spdSay?.fix).toContain("apt install");
    expect(spdSay?.detail).toContain("not found");
  });

  it("should_leave_fix_null_for_os_bundled_binary", async () => {
    const checks = await checkAll({
      which: whichNone,
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "say")?.fix).toBeNull();
  });

  it("should_append_beta_note_on_linux", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("linux"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "spd-say")?.detail.toLowerCase()).toContain("beta");
  });

  it("should_append_beta_note_on_win32", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("win32"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "powershell")?.detail.toLowerCase()).toContain("beta");
  });

  it("should_not_append_beta_note_on_darwin", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "say")?.detail.toLowerCase()).not.toContain("beta");
  });
});

describe("allRequiredOk", () => {
  it("should_be_true_when_only_optional_binary_missing", async () => {
    const checks = await checkAll({
      which: whichWith("say", "osascript"),
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
    });
    expect(byKey(checks, "afplay")?.ok).toBe(false);
    expect(allRequiredOk(checks)).toBe(true);
  });

  it("should_be_false_when_a_required_binary_missing", async () => {
    const checks = await checkAll({
      which: whichWith("osascript", "afplay"),
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
    });
    expect(allRequiredOk(checks)).toBe(false);
  });

  it("should_ignore_informational_adapter_checks", () => {
    const checks: Check[] = [
      { key: "node", label: "Node.js", ok: true, required: true, detail: "", fix: null },
      { key: "x", label: "X", ok: false, required: false, detail: "", fix: null },
    ];
    expect(allRequiredOk(checks)).toBe(true);
  });
});

describe("checkAll — bare machine", () => {
  it("should_not_throw_and_report_required_failure_when_everything_missing", async () => {
    const checks = await checkAll({
      which: whichNone,
      platform: selectPlatform("linux"),
      nodeVersion: "18.0.0",
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(allRequiredOk(checks)).toBe(false);
  });
});

describe("checkAll — adapters (informational)", () => {
  const installedAgent: DetectableAgent = {
    id: "claude",
    title: "Claude Code",
    detect: () => Promise.resolve({ installed: true }),
  };
  const degradedAgent: DetectableAgent = {
    id: "codex",
    title: "Codex",
    detect: () => Promise.resolve({ installed: true, degraded: "no hooks dir" }),
  };
  const throwingAgent: DetectableAgent = {
    id: "boom",
    title: "Boom",
    detect: () => Promise.reject(new Error("detect blew up")),
  };

  function baseDeps(adapters: DetectableAgent[]): Parameters<typeof checkAll>[0] {
    return {
      which: whichAll,
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
      adapters,
    };
  }

  it("should_mark_installed_adapter_ok_and_informational", async () => {
    const checks = await checkAll(baseDeps([installedAgent]));
    const claude = byKey(checks, "claude");
    expect(claude?.required).toBe(false);
    expect(claude?.ok).toBe(true);
  });

  it("should_surface_degraded_detail", async () => {
    const checks = await checkAll(baseDeps([degradedAgent]));
    expect(byKey(checks, "codex")?.detail).toContain("no hooks dir");
  });

  it("should_treat_throwing_detect_as_not_installed_without_crashing", async () => {
    const checks = await checkAll(baseDeps([throwingAgent, installedAgent]));
    const boom = byKey(checks, "boom");
    expect(boom?.ok).toBe(false);
    expect(boom?.required).toBe(false);
    // A crashing adapter must never break the required verdict.
    expect(allRequiredOk(checks)).toBe(true);
    // Other adapters still reported.
    expect(byKey(checks, "claude")?.ok).toBe(true);
  });

  it("should_default_adapters_to_empty_when_omitted", async () => {
    const checks = await checkAll({
      which: whichAll,
      platform: selectPlatform("darwin") satisfies Platform,
      nodeVersion: NODE_OK,
    });
    // Only node + 3 darwin binaries, no adapter checks.
    expect(checks).toHaveLength(4);
  });

  it("should_pass_a_working_adapter_deps_home_to_detect", async () => {
    let seenHome: string | undefined;
    let seenWhich: ((bin: string) => string | null) | undefined;
    // Real adapters read deps.home/deps.which; a probe with no args would throw
    // and be reported "not installed". This proves detect receives real deps.
    const depsProbe: DetectableAgent = {
      id: "probe",
      title: "Probe",
      detect: (deps) => {
        seenHome = deps.home;
        seenWhich = deps.which;
        return Promise.resolve({ installed: deps.which("probe-bin") !== null });
      },
    };
    const checks = await checkAll({
      which: whichWith("probe-bin"),
      platform: selectPlatform("darwin"),
      nodeVersion: NODE_OK,
      adapters: [depsProbe],
      home: "/tmp/injected-home",
    });
    expect(seenHome).toBe("/tmp/injected-home");
    expect(seenWhich).toBeTypeOf("function");
    expect(byKey(checks, "probe")?.ok).toBe(true);
  });
});
