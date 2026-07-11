/**
 * Windows engine (beta). Drives PowerShell for speech (System.Speech), toast
 * notifications (Windows.UI.Notifications), and system sounds (SoundPlayer).
 *
 * SECURITY: the speech/notify scripts are PowerShell command strings, so
 * user-controlled text (speech content, notification title/body) is NEVER
 * interpolated into the script. It is written to a temp file and read back with
 * `[IO.File]::ReadAllText`, so no quoting or metacharacter can escape into the
 * command line. Only non-user values are interpolated: the temp-file path, the
 * numeric rate, and an optional voice name that must match a strict allowlist.
 * Sound names are sanitized (no `.`/`/`/`\`) before reaching the argv.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hollrHome } from "../core/config.ts";
import type { Platform, RequiredBinary } from "./index.ts";

const POWERSHELL = ["powershell", "-NoProfile", "-Command"] as const;

const TMP_SUBDIR = "tmp";
const SPEECH_TMP_PREFIX = "speech";
const NOTIFY_TITLE_TMP_PREFIX = "notify-title";
const NOTIFY_BODY_TMP_PREFIX = "notify-body";

/** `SpeechSynthesizer.Rate` bounds and the wpm anchors it is fitted to. */
const RATE_MIN = -10;
const RATE_MAX = 10;
const RATE_BASE_WPM = 190;
const RATE_SLOW_ANCHOR_WPM = 150;
const RATE_SLOW_ANCHOR = -3;
const RATE_FAST_ANCHOR_WPM = 220;
const RATE_FAST_ANCHOR = 3;
const RATE_SLOW_SLOPE = RATE_SLOW_ANCHOR / (RATE_SLOW_ANCHOR_WPM - RATE_BASE_WPM);
const RATE_FAST_SLOPE = RATE_FAST_ANCHOR / (RATE_FAST_ANCHOR_WPM - RATE_BASE_WPM);

/** Only a voice name of letters, digits, and spaces may be interpolated. */
const VOICE_NAME_RE = /^[A-Za-z0-9 ]+$/;

/** System media directory; names resolve to `<name>.wav`. */
const SOUND_DIR = "C:\\Windows\\Media";
/** Multi-word names allowed but no `.`, `/`, `\`, or metachars (blocks traversal). */
const SOUND_NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/** Injectable `PATH` lookup, accepted for construction symmetry with other engines. */
type Which = (bin: string) => string | null;
/** Injectable existence check so sound resolution is deterministically testable. */
type FileExists = (path: string) => boolean;

/** Map words-per-minute to the `SpeechSynthesizer.Rate` scale [-10, 10]. */
function toSynthRate(rateWpm: number): number {
  if (!Number.isFinite(rateWpm)) {
    return 0;
  }
  const delta = rateWpm - RATE_BASE_WPM;
  const slope = delta < 0 ? RATE_SLOW_SLOPE : RATE_FAST_SLOPE;
  const rate = Math.round(delta * slope);
  return Math.max(RATE_MIN, Math.min(RATE_MAX, rate));
}

export class Win32Platform implements Platform {
  readonly id = "win32" as const;
  readonly canPauseResume = false;
  readonly requiredBinaries: RequiredBinary[] = [{ name: "powershell", fix: null }];

  readonly #fileExists: FileExists;

  // `which` is injected for construction symmetry with the other engines, but
  // win32 depends only on the built-in `powershell`, so it is not retained.
  constructor(_which: Which, fileExists: FileExists = existsSync) {
    this.#fileExists = fileExists;
  }

  voiceArgv(text: string, voice: string | null, rateWpm: number): string[] | null {
    if (text.trim().length === 0) {
      return null;
    }
    const tmp = this.#writeTmp(SPEECH_TMP_PREFIX, text);
    const voiceLine =
      voice !== null && VOICE_NAME_RE.test(voice) ? `$s.SelectVoice('${voice}')` : null;
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.Rate=${toSynthRate(rateWpm)}`,
      ...(voiceLine === null ? [] : [voiceLine]),
      `$s.Speak([IO.File]::ReadAllText('${tmp}'))`,
      removeItem(tmp),
    ].join("; ");
    return [...POWERSHELL, script];
  }

  notifyArgv(title: string, body: string): string[] | null {
    const titleTmp = this.#writeTmp(NOTIFY_TITLE_TMP_PREFIX, title);
    const bodyTmp = this.#writeTmp(NOTIFY_BODY_TMP_PREFIX, body);
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
      "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$n=$t.GetElementsByTagName('text')",
      `$n.Item(0).AppendChild($t.CreateTextNode([IO.File]::ReadAllText('${titleTmp}'))) > $null`,
      `$n.Item(1).AppendChild($t.CreateTextNode([IO.File]::ReadAllText('${bodyTmp}'))) > $null`,
      "$toast=[Windows.UI.Notifications.ToastNotification]::new($t)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('hollr').Show($toast)",
      removeItem(titleTmp),
      removeItem(bodyTmp),
    ].join("; ");
    return [...POWERSHELL, script];
  }

  soundArgv(soundName: string): string[] | null {
    if (!SOUND_NAME_RE.test(soundName)) {
      return null;
    }
    const path = `${SOUND_DIR}\\${soundName}.wav`;
    if (!this.#fileExists(path)) {
      return null;
    }
    return [...POWERSHELL, `(New-Object Media.SoundPlayer '${path}').PlaySync()`];
  }

  enumerateVoicesArgv(): string[] | null {
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "(New-Object System.Speech.Synthesis.SpeechSynthesizer)" +
      ".GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }";
    return [...POWERSHELL, script];
  }

  parseVoicesOutput(raw: string): string[] {
    const names: string[] = [];
    for (const line of raw.split("\n")) {
      const name = line.trim();
      if (name.length > 0) {
        names.push(name);
      }
    }
    return names;
  }

  /** Write `text` to `<HOLLR_HOME>/tmp/<prefix>-<pid>.txt` and return its path. */
  #writeTmp(prefix: string, text: string): string {
    const dir = join(hollrHome(), TMP_SUBDIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${prefix}-${process.pid}.txt`);
    writeFileSync(path, text, "utf8");
    return path;
  }
}

/** PowerShell cleanup fragment that removes a temp file, ignoring failure. */
function removeItem(path: string): string {
  return `Remove-Item '${path}' -ErrorAction SilentlyContinue`;
}
