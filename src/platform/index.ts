/**
 * Platform abstraction: each OS engine turns kelbrin's intent (speak, notify,
 * play a sound, list voices) into a concrete argv array that a caller runs via
 * {@link spawnDetached}. Engines never spawn or touch a shell themselves — they
 * only build argv, which keeps injection impossible (no `shell: true`, no string
 * interpolation into a command line) and makes every engine deterministically
 * unit-testable.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import { DarwinPlatform } from "./darwin.ts";
import { LinuxPlatform } from "./linux.ts";
import { Win32Platform } from "./win32.ts";

/** A binary an engine relies on; consumed by the doctor command (Task 7). */
export interface RequiredBinary {
  /** Executable name, e.g. `say`. */
  name: string;
  /** Human-readable install hint, or `null` when it ships with the OS. */
  fix: string | null;
  /** True when the engine degrades gracefully without it (e.g. `afplay`). */
  optional?: boolean;
}

export interface Platform {
  id: "darwin" | "linux" | "win32";
  /** Argv for text-to-speech, or `null` when text is empty/unavailable. */
  voiceArgv(text: string, voice: string | null, rateWpm: number): string[] | null;
  /** Argv for a desktop notification, or `null` when unavailable. */
  notifyArgv(title: string, body: string): string[] | null;
  /** Argv to play a named system sound; `null` if the name is rejected or the file is absent. */
  soundArgv(soundName: string): string[] | null;
  /** Argv that lists installed voices, or `null` when unsupported. */
  enumerateVoicesArgv(): string[] | null;
  /** Parse this platform's voice-list stdout into voice names. */
  parseVoicesOutput(raw: string): string[];
  /** Whether the platform can pause/resume speech (SIGSTOP/SIGCONT). */
  canPauseResume: boolean;
  /** Binaries this engine needs, for preflight checks. */
  requiredBinaries: RequiredBinary[];
}

/**
 * Locate `bin` on `PATH`, returning its absolute path or `null`. A minimal
 * dependency-free `which`: it scans `PATH` entries for an executable file (and
 * `PATHEXT` variants on Windows). Engines inject a fake in tests, so this only
 * runs in production via {@link selectPlatform}; the doctor command reuses it as
 * its real `which`.
 */
export function whichOnPath(bin: string): string | null {
  const pathEnv = process.env.PATH;
  if (pathEnv === undefined || pathEnv.length === 0) {
    return null;
  }
  const isWindows = process.platform === "win32";
  const mode = isWindows ? constants.F_OK : constants.X_OK;
  const extensions = isWindows
    ? (process.env.PATHEXT ?? ".EXE").split(delimiter)
    : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${bin}${extension}`);
      try {
        accessSync(candidate, mode);
        return candidate;
      } catch {
        // Not executable here; try the next directory/extension.
      }
    }
  }
  return null;
}

/** Pick the engine for the current (or given) platform. */
export function selectPlatform(id: NodeJS.Platform = process.platform): Platform {
  switch (id) {
    case "darwin":
      return new DarwinPlatform();
    case "linux":
      return new LinuxPlatform(whichOnPath);
    case "win32":
      return new Win32Platform(whichOnPath);
    default:
      throw new Error(`unsupported platform: ${id}`);
  }
}

/**
 * Run `argv` fully detached: no controlling terminal, ignored stdio, and
 * `unref` so it never keeps the hook process alive. Spawn failures (e.g. a
 * missing binary) surface as an async `error` event, which is swallowed —
 * this runs inside a Claude Code hook that must never block or throw.
 */
export function spawnDetached(argv: string[]): void {
  const command = argv[0];
  if (command === undefined) {
    return;
  }
  const child = spawn(command, argv.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}
