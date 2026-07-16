import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULTS,
  defaultOpenCommand,
  encodeCwd,
  kelbrinHome,
  inQuietHours,
  isConfigured,
  isProjectEnabled,
  isMuted,
  loadConfig,
  migrateHttpOptIn,
  migrateLegacyHome,
  migrateV1,
  quietActive,
  quietUntilPath,
} from "../../src/core/config.ts";
import type { KelbrinConfig, WebhookTarget } from "../../src/core/config.ts";

const PROJECT = "/some/project";

let tmpRoot: string;
let kelbrinHomeDir: string;
let prevHome: string | undefined;
let prevKelbrinHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kelbrin-cfg-"));
  kelbrinHomeDir = join(tmpRoot, ".config", "kelbrin");
  prevHome = process.env.HOME;
  prevKelbrinHome = process.env.KELBRIN_HOME;
  // Isolate both v2 home ($KELBRIN_HOME) and v1 source (~/.claude via $HOME).
  process.env.HOME = tmpRoot;
  process.env.KELBRIN_HOME = kelbrinHomeDir;
});

afterEach(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("KELBRIN_HOME", prevKelbrinHome);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function writeGlobal(config: unknown): void {
  mkdirSync(kelbrinHomeDir, { recursive: true });
  writeFileSync(join(kelbrinHomeDir, "config.json"), JSON.stringify(config));
}

function writeGlobalRaw(raw: string): void {
  mkdirSync(kelbrinHomeDir, { recursive: true });
  writeFileSync(join(kelbrinHomeDir, "config.json"), raw);
}

function writeProject(cwd: string, config: unknown): void {
  const dir = join(kelbrinHomeDir, "projects");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encodeCwd(cwd)}.json`), JSON.stringify(config));
}

function touchMute(cwd: string): void {
  const dir = join(kelbrinHomeDir, "projects");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encodeCwd(cwd)}.muted`), "");
}

function writeV1(config: unknown): void {
  const dir = join(tmpRoot, ".claude", "hollr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

describe("encodeCwd", () => {
  it("should_replace_every_non_alphanumeric_char_with_dash", () => {
    expect(encodeCwd("/Users/me/my.app")).toBe("-Users-me-my-app");
  });
});

describe("loadConfig", () => {
  it("should_return_defaults_when_no_files_present", () => {
    const cfg = loadConfig(PROJECT);
    expect(cfg.events.done.mode).toBe("announce");
    expect(cfg.events.blocked.mode).toBe("announce");
    expect(cfg.events.error.mode).toBe("notify");
    expect(cfg.voice.name).toBeNull();
    expect(cfg.voice.rateWpm).toBe(190);
    expect(cfg.quietHours).toBeNull();
    expect(cfg.quietHoursWebhooks).toBe("fire");
    expect(cfg.notify.desktop).toBe(true);
    expect(cfg.notify.sound).toBeNull();
    expect(cfg.webhooks).toEqual([]);
    expect(cfg.allowHttp).toBe(false);
  });

  it("should_apply_project_over_global_over_defaults", () => {
    writeGlobal({
      quietHours: "22:00-08:00",
      voice: { name: "Alex", rateWpm: 200 },
    });
    writeProject(PROJECT, { quietHours: null });
    const cfg = loadConfig(PROJECT);
    expect(cfg.voice.name).toBe("Alex"); // from global
    expect(cfg.voice.rateWpm).toBe(200); // from global
    expect(cfg.quietHours).toBeNull(); // project overrides global
    expect(cfg.events.done.mode).toBe("announce"); // default survives
  });

  it("should_preserve_defaults_for_unset_keys_in_partial_nested_override", () => {
    writeGlobal({
      events: { done: { mode: "notify" } },
      voice: { name: "Alex" },
    });
    const cfg = loadConfig(PROJECT);
    expect(cfg.events.done.mode).toBe("notify");
    expect(cfg.events.blocked.mode).toBe("announce"); // default survives
    expect(cfg.events.error.mode).toBe("notify"); // default survives
    expect(cfg.voice.rateWpm).toBe(190); // default survives
    expect(cfg.voice.name).toBe("Alex");
  });

  it("should_fall_back_to_defaults_when_global_file_is_malformed", () => {
    writeGlobalRaw("{not json");
    const cfg = loadConfig(PROJECT);
    expect(cfg).toEqual(DEFAULTS);
  });

  it("should_not_throw_on_bad_typed_values", () => {
    writeGlobal({ events: "loud", voice: { rateWpm: "fast" } });
    expect(() => loadConfig(PROJECT)).not.toThrow();
  });

  it("should_default_openCommand_to_empty", () => {
    expect(loadConfig(PROJECT).readaloud.openCommand).toBe("");
  });
});

describe("defaultOpenCommand", () => {
  it("should_map_platform_to_the_os_opener", () => {
    expect(defaultOpenCommand("darwin")).toBe("open");
    expect(defaultOpenCommand("win32")).toBe("start");
    expect(defaultOpenCommand("linux")).toBe("xdg-open");
  });
});

describe("isConfigured", () => {
  it("should_be_false_when_no_config_exists", () => {
    expect(isConfigured(PROJECT)).toBe(false);
  });

  it("should_be_true_when_global_config_exists", () => {
    writeGlobal({});
    expect(isConfigured(PROJECT)).toBe(true);
  });

  it("should_be_true_when_only_project_override_exists", () => {
    writeProject("/p", {});
    expect(isConfigured("/p")).toBe(true);
  });
});

describe("isMuted", () => {
  it("should_reflect_presence_of_mute_flag_file", () => {
    expect(isMuted("/p")).toBe(false);
    touchMute("/p");
    expect(isMuted("/p")).toBe(true);
  });
});

describe("inQuietHours", () => {
  const at = (hhmm: string): Date => {
    const [h, m] = hhmm.split(":");
    return new Date(2026, 6, 11, Number(h), Number(m));
  };

  it("should_detect_same_day_window", () => {
    expect(inQuietHours("09:00-17:00", at("12:00"))).toBe(true);
    expect(inQuietHours("09:00-17:00", at("18:00"))).toBe(false);
  });

  it("should_wrap_across_midnight", () => {
    expect(inQuietHours("22:00-08:00", at("23:30"))).toBe(true);
    expect(inQuietHours("22:00-08:00", at("07:59"))).toBe(true);
    expect(inQuietHours("22:00-08:00", at("12:00"))).toBe(false);
  });

  it("should_return_false_for_null_or_malformed_spec", () => {
    expect(inQuietHours(null, at("12:00"))).toBe(false);
    expect(inQuietHours("garbage", at("12:00"))).toBe(false);
    expect(inQuietHours("25:00-99:99", at("12:00"))).toBe(false);
    expect(inQuietHours("", at("12:00"))).toBe(false);
  });
});

describe("migrateHttpOptIn", () => {
  function configWith(
    allowHttp: boolean,
    webhooks: WebhookTarget[],
  ): KelbrinConfig {
    return { ...structuredClone(DEFAULTS), allowHttp, webhooks };
  }

  function target(url: string, allowHttp?: boolean): WebhookTarget {
    const t: WebhookTarget = { name: url, provider: "generic", url, events: ["done"] };
    if (allowHttp !== undefined) {
      t.allowHttp = allowHttp;
    }
    return t;
  }

  it("should_move_root_flag_onto_http_targets_and_clear_root", () => {
    const { config, changed } = migrateHttpOptIn(
      configWith(true, [target("http://a.example"), target("https://b.example")]),
    );
    expect(changed).toBe(true);
    expect(config.allowHttp).toBe(false);
    expect(config.webhooks[0]?.allowHttp).toBe(true); // http gets the opt-in
    expect(config.webhooks[1]?.allowHttp).toBeUndefined(); // https never needed it
  });

  it("should_leave_an_explicit_per_target_flag_untouched", () => {
    const { config } = migrateHttpOptIn(
      configWith(true, [target("http://a.example", false)]),
    );
    // Explicit false means the user declined this target; migration must respect it.
    expect(config.webhooks[0]?.allowHttp).toBe(false);
    expect(config.allowHttp).toBe(false);
  });

  it("should_be_a_no_op_when_root_flag_is_already_false", () => {
    const input = configWith(false, [target("http://a.example")]);
    const { config, changed } = migrateHttpOptIn(input);
    expect(changed).toBe(false);
    expect(config).toBe(input); // unchanged, same reference
  });

  it("should_be_idempotent", () => {
    const first = migrateHttpOptIn(
      configWith(true, [target("http://a.example")]),
    );
    const second = migrateHttpOptIn(first.config);
    expect(second.changed).toBe(false);
    expect(second.config.webhooks[0]?.allowHttp).toBe(true);
  });
});

describe("kelbrinHome", () => {
  it("should_fall_back_to_legacy_HOLLR_HOME_when_KELBRIN_HOME_unset", () => {
    const prevLegacy = process.env.HOLLR_HOME;
    delete process.env.KELBRIN_HOME;
    process.env.HOLLR_HOME = join(tmpRoot, "legacy-home");
    try {
      expect(kelbrinHome()).toBe(join(tmpRoot, "legacy-home"));
    } finally {
      restoreEnv("HOLLR_HOME", prevLegacy);
    }
  });
});

describe("migrateLegacyHome", () => {
  const legacyDir = (): string => join(tmpRoot, ".config", "hollr");
  const newDir = (): string => join(tmpRoot, ".config", "kelbrin");

  it("should_rename_legacy_hollr_home_when_kelbrin_home_missing", () => {
    delete process.env.KELBRIN_HOME;
    mkdirSync(legacyDir(), { recursive: true });
    writeFileSync(join(legacyDir(), "config.json"), "{}\n", "utf8");
    migrateLegacyHome();
    expect(existsSync(join(newDir(), "config.json"))).toBe(true);
    expect(existsSync(legacyDir())).toBe(false);
  });

  it("should_leave_both_dirs_untouched_when_kelbrin_home_exists", () => {
    delete process.env.KELBRIN_HOME;
    mkdirSync(legacyDir(), { recursive: true });
    writeFileSync(join(legacyDir(), "config.json"), "{}\n", "utf8");
    mkdirSync(newDir(), { recursive: true });
    writeFileSync(join(newDir(), "config.json"), '{"version":2}\n', "utf8");
    migrateLegacyHome();
    expect(existsSync(join(legacyDir(), "config.json"))).toBe(true);
    expect(readFileSync(join(newDir(), "config.json"), "utf8")).toContain('"version":2');
  });

  it("should_skip_migration_when_an_env_override_is_set", () => {
    mkdirSync(legacyDir(), { recursive: true });
    migrateLegacyHome(); // KELBRIN_HOME points elsewhere (beforeEach)
    expect(existsSync(legacyDir())).toBe(true);
    expect(existsSync(newDir())).toBe(false);
  });

  it("should_do_nothing_when_no_legacy_dir_exists", () => {
    delete process.env.KELBRIN_HOME;
    migrateLegacyHome();
    expect(existsSync(newDir())).toBe(false);
  });
});

describe("migrateV1", () => {
  it("should_migrate_v1_config_and_map_renamed_fields", () => {
    writeV1({
      voice: { engine: "system", name: "Alex", rate_wpm: 210 },
      readaloud: { max_chars: 500, strip_code: false },
      quiet_hours: "22:00-08:00",
      events: { done: { mode: "notify" }, needs_input: { mode: "readaloud" } },
    });
    expect(migrateV1()).toBe(true);
    const cfg = loadConfig(PROJECT);
    expect(cfg.version).toBe(2);
    expect(cfg.voice.name).toBe("Alex");
    expect(cfg.voice.rateWpm).toBe(210);
    expect(cfg.readaloud.maxChars).toBe(500);
    expect(cfg.readaloud.stripCode).toBe(false);
    expect(cfg.quietHours).toBe("22:00-08:00");
    expect(cfg.events.done.mode).toBe("notify");
    expect(cfg.events.blocked.mode).toBe("readaloud"); // needs_input -> blocked
  });

  it("should_return_false_when_no_v1_config_present", () => {
    expect(migrateV1()).toBe(false);
    expect(isConfigured(PROJECT)).toBe(false);
  });

  it("should_never_clobber_an_existing_v2_config", () => {
    writeGlobal({ voice: { name: "Existing", rateWpm: 111 } });
    writeV1({ voice: { name: "Old", rate_wpm: 999 } });
    expect(migrateV1()).toBe(false);
    const cfg = loadConfig(PROJECT);
    expect(cfg.voice.name).toBe("Existing"); // untouched
    expect(cfg.voice.rateWpm).toBe(111);
  });

  it("should_not_migrate_when_a_stray_project_file_exists", () => {
    // Any *.json under projects/ means v2 is configured, so a project
    // override suppresses migration even when a v1 config is present.
    writeProject("/unrelated", { quietHours: null });
    writeV1({ voice: { name: "Old", rate_wpm: 999 } });
    expect(migrateV1()).toBe(false);
  });

  it("should_return_false_and_not_throw_when_the_write_fails", () => {
    writeV1({ voice: { name: "Alex", rate_wpm: 210 } });
    // Point KELBRIN_HOME below a plain file so mkdirSync(recursive) hits
    // ENOTDIR — the write fails without relying on filesystem permissions.
    const blocker = join(tmpRoot, "blocker");
    writeFileSync(blocker, "");
    process.env.KELBRIN_HOME = join(blocker, "kelbrin");
    let result: boolean | undefined;
    expect(() => {
      result = migrateV1();
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe("activation default", () => {
  it("defaults activation to 'all' when absent from the config file", () => {
    mkdirSync(kelbrinHome(), { recursive: true });
    writeFileSync(join(kelbrinHome(), "config.json"), JSON.stringify({ version: 2 }));
    expect(loadConfig("/tmp/proj").activation).toBe("all");
  });
  it("reads an explicit opt-in activation", () => {
    mkdirSync(kelbrinHome(), { recursive: true });
    writeFileSync(join(kelbrinHome(), "config.json"), JSON.stringify({ activation: "opt-in" }));
    expect(loadConfig("/tmp/proj").activation).toBe("opt-in");
  });
});

describe("isProjectEnabled", () => {
  it("is false when no .enabled marker exists", () => {
    expect(isProjectEnabled("/tmp/proj")).toBe(false);
  });
  it("is true when the .enabled marker exists", () => {
    const dir = join(kelbrinHome(), "projects");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${encodeCwd("/tmp/proj")}.enabled`), "");
    expect(isProjectEnabled("/tmp/proj")).toBe(true);
  });
});

describe("quietActive", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  const writeQuiet = (body: string) => {
    mkdirSync(kelbrinHome(), { recursive: true });
    writeFileSync(quietUntilPath(), body);
  };
  it("is false when no quiet-until marker exists", () => {
    expect(quietActive(now)).toBe(false);
  });
  it("is true for an indefinite quiet", () => {
    writeQuiet("indefinite");
    expect(quietActive(now)).toBe(true);
  });
  it("is true when the expiry is in the future", () => {
    writeQuiet(String(now.getTime() + 60_000));
    expect(quietActive(now)).toBe(true);
  });
  it("is false when the expiry has elapsed", () => {
    writeQuiet(String(now.getTime() - 1));
    expect(quietActive(now)).toBe(false);
  });
  it("is false for a garbage marker", () => {
    writeQuiet("not-a-number");
    expect(quietActive(now)).toBe(false);
  });
});
