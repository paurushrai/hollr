/**
 * Linux engine (beta). Builds argv for `spd-say`/`espeak(-ng)` (speech),
 * `notify-send` (desktop notification), and `paplay`/`aplay` (system sound).
 * Every value the OS receives is a distinct argv element — no shell, no string
 * interpolation — so a voice name or sound name can never inject arguments;
 * the sound-name sanitizer additionally blocks path traversal.
 */

import { existsSync } from "node:fs";

import type { Platform, RequiredBinary } from "./index.ts";
import { coerceRate, rateToSpd } from "./rate.ts";

const MAX_SPEECH_CHARS = 2000;
const MAX_NOTIFY_TITLE = 60;
const MAX_NOTIFY_BODY = 200;

const SPD_SAY = "spd-say";
const ESPEAK_NG = "espeak-ng";
const ESPEAK = "espeak";
const NOTIFY_SEND = "notify-send";
const PAPLAY = "paplay";
const APLAY = "aplay";

/** Freedesktop stereo sound theme directory; names resolve to `<name>.oga`. */
const SOUND_DIR = "/usr/share/sounds/freedesktop/stereo";
/** Multi-word names are allowed but no `.`, `/`, or metachars (blocks traversal). */
const SOUND_NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/** `espeak-ng --voices` header prefix; distinguishes it from `spd-say -L`. */
const ESPEAK_HEADER_PREFIX = "Pty";
const ESPEAK_NAME_COLUMN = 3;
const SPD_NAME_COLUMN = 0;

/** Injectable `PATH` lookup so engine selection is deterministically testable. */
type Which = (bin: string) => string | null;
/** Injectable existence check so sound resolution is deterministically testable. */
type FileExists = (path: string) => boolean;

/** True for an explicit, non-empty voice name (narrows out `null`). */
function hasVoice(voice: string | null): voice is string {
  return voice !== null && voice.length > 0;
}

export class LinuxPlatform implements Platform {
  readonly id = "linux" as const;
  readonly canPauseResume = true;
  readonly requiredBinaries: RequiredBinary[] = [
    { name: SPD_SAY, fix: "sudo apt install speech-dispatcher" },
    { name: NOTIFY_SEND, fix: "sudo apt install libnotify-bin" },
    { name: PAPLAY, fix: "sudo apt install pulseaudio-utils", optional: true },
  ];

  readonly #which: Which;
  readonly #fileExists: FileExists;

  constructor(which: Which, fileExists: FileExists = existsSync) {
    this.#which = which;
    this.#fileExists = fileExists;
  }

  voiceArgv(text: string, voice: string | null, rateWpm: number): string[] | null {
    if (text.trim().length === 0) {
      return null;
    }
    const body = text.slice(0, MAX_SPEECH_CHARS);
    if (this.#which(SPD_SAY) !== null) {
      const voiceArgs = hasVoice(voice) ? ["-y", voice] : [];
      return [SPD_SAY, ...voiceArgs, "-r", rateToSpd(rateWpm), "--wait", body];
    }
    const espeak = this.#selectEspeak();
    if (espeak === null) {
      return null;
    }
    const voiceArgs = hasVoice(voice) ? ["-v", voice] : [];
    return [espeak, ...voiceArgs, "-s", String(coerceRate(rateWpm)), "--", body];
  }

  notifyArgv(title: string, body: string): string[] | null {
    return [
      NOTIFY_SEND,
      "--app-name=hollr",
      title.slice(0, MAX_NOTIFY_TITLE),
      body.slice(0, MAX_NOTIFY_BODY),
    ];
  }

  soundArgv(soundName: string): string[] | null {
    if (!SOUND_NAME_RE.test(soundName)) {
      return null;
    }
    const path = `${SOUND_DIR}/${soundName}.oga`;
    if (!this.#fileExists(path)) {
      return null;
    }
    if (this.#which(PAPLAY) !== null) {
      return [PAPLAY, path];
    }
    if (this.#which(APLAY) !== null) {
      return [APLAY, path];
    }
    return null;
  }

  enumerateVoicesArgv(): string[] | null {
    if (this.#which(SPD_SAY) !== null) {
      return [SPD_SAY, "-L"];
    }
    if (this.#which(ESPEAK_NG) !== null) {
      return [ESPEAK_NG, "--voices"];
    }
    return null;
  }

  parseVoicesOutput(raw: string): string[] {
    const lines = raw.split("\n");
    const header = lines[0] ?? "";
    const column = header.trimStart().startsWith(ESPEAK_HEADER_PREFIX)
      ? ESPEAK_NAME_COLUMN
      : SPD_NAME_COLUMN;
    const names: string[] = [];
    for (const line of lines.slice(1)) {
      const name = line.trim().split(/\s+/)[column];
      if (name !== undefined && name.length > 0) {
        names.push(name);
      }
    }
    return names;
  }

  /** Pick the available espeak binary (`espeak-ng` preferred), or `null`. */
  #selectEspeak(): string | null {
    if (this.#which(ESPEAK_NG) !== null) {
      return ESPEAK_NG;
    }
    if (this.#which(ESPEAK) !== null) {
      return ESPEAK;
    }
    return null;
  }
}
