/**
 * Platform abstraction: each OS engine turns hollr's intent (speak, notify,
 * play a sound, list voices) into a concrete argv array that a caller runs via
 * {@link spawnDetached}. Engines never spawn or touch a shell themselves — they
 * only build argv, which keeps injection impossible (no `shell: true`, no string
 * interpolation into a command line) and makes every engine deterministically
 * unit-testable.
 */

import { spawn } from "node:child_process";

import { DarwinPlatform } from "./darwin.ts";

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
 * Pick the engine for the current (or given) platform. Only darwin is
 * implemented; linux/win32 (and anything else) throw until Task 4 replaces
 * this switch with real engines.
 */
export function selectPlatform(id: NodeJS.Platform = process.platform): Platform {
  if (id === "darwin") {
    return new DarwinPlatform();
  }
  throw new Error(`platform not yet implemented: ${id} (Task 4)`);
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
