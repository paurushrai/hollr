/**
 * macOS (darwin) engine. Builds argv for the built-in `say`, `osascript`, and
 * `afplay` binaries. Ported behavior-for-behavior from kelbrin v1's
 * `lib/speech.py`; the sanitizers below are security boundaries — they block
 * argument injection and path traversal at the point argv is constructed.
 */

import { existsSync } from "node:fs";

import type { Platform, RequiredBinary } from "./index.ts";
import { coerceRate } from "./rate.ts";

const MAX_SPEECH_CHARS = 2000;
const MAX_NOTIFY_BODY = 200;
const MAX_NOTIFY_TITLE = 60;
const SOUND_DIR = "/System/Library/Sounds";

/** Only a single bare word is a valid sound name — blocks paths and metachars. */
const SOUND_NAME_RE = /^[A-Za-z]+$/;
/** Values that mean "use the OS-configured default voice" (omit `-v`). */
const SYSTEM_VOICE_SENTINELS: ReadonlySet<string> = new Set(["", "system", "default"]);
/** A `say -v ?` locale token (e.g. `en_US`), the boundary after a voice name. */
const LOCALE_TOKEN_RE = /\s+[a-z]{2}_[A-Z]{2}/;
/** A run of two or more spaces — the fallback voice-name boundary. */
const COLUMN_GAP_RE = /\s{2,}/;

/** Injectable existence check so sound resolution is deterministically testable. */
type FileExists = (path: string) => boolean;

/** True for an explicit, non-sentinel voice name (narrows out `null`). */
function isNamedVoice(voice: string | null): voice is string {
  if (voice === null) {
    return false;
  }
  return !SYSTEM_VOICE_SENTINELS.has(voice.trim().toLowerCase());
}

/** Neutralize AppleScript string escapes: drop backslashes, then quotes -> '. */
function applescriptSafe(text: string): string {
  return text.replace(/\\/g, "").replace(/"/g, "'");
}

/** Extract the voice name (everything left of the locale/column boundary). */
function parseVoiceLine(line: string): string | null {
  if (line.trim().length === 0) {
    return null;
  }
  const boundary = LOCALE_TOKEN_RE.exec(line) ?? COLUMN_GAP_RE.exec(line);
  if (boundary === null || boundary.index === 0) {
    return null;
  }
  const name = line.slice(0, boundary.index).trim();
  return name.length > 0 ? name : null;
}

export class DarwinPlatform implements Platform {
  readonly id = "darwin" as const;
  readonly canPauseResume = true;
  readonly requiredBinaries: RequiredBinary[] = [
    { name: "say", fix: null },
    { name: "osascript", fix: null },
    { name: "afplay", fix: null, optional: true },
  ];

  readonly #fileExists: FileExists;

  constructor(fileExists: FileExists = existsSync) {
    this.#fileExists = fileExists;
  }

  voiceArgv(text: string, voice: string | null, rateWpm: number): string[] | null {
    if (text.trim().length === 0) {
      return null;
    }
    const voiceArgs = isNamedVoice(voice) ? ["-v", voice] : [];
    return [
      "say",
      ...voiceArgs,
      "-r",
      String(coerceRate(rateWpm)),
      "--",
      text.slice(0, MAX_SPEECH_CHARS),
    ];
  }

  notifyArgv(title: string, body: string): string[] | null {
    const safeBody = applescriptSafe(body).slice(0, MAX_NOTIFY_BODY);
    const safeTitle = applescriptSafe(title).slice(0, MAX_NOTIFY_TITLE);
    const script = `display notification "${safeBody}" with title "${safeTitle}"`;
    return ["osascript", "-e", script];
  }

  soundArgv(soundName: string): string[] | null {
    if (!SOUND_NAME_RE.test(soundName)) {
      return null;
    }
    const path = `${SOUND_DIR}/${soundName}.aiff`;
    return this.#fileExists(path) ? ["afplay", path] : null;
  }

  enumerateVoicesArgv(): string[] | null {
    return ["say", "-v", "?"];
  }

  parseVoicesOutput(raw: string): string[] {
    const names: string[] = [];
    for (const line of raw.split("\n")) {
      const name = parseVoiceLine(line);
      if (name !== null) {
        names.push(name);
      }
    }
    return names;
  }
}
