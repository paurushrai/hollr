/**
 * Sound-then-voice sequencer. hollr must never play a notification chime and
 * speak at the same time, so it hands both intents to a detached helper
 * ({@link HELPER_PATH}) that runs the sound to completion *before* starting the
 * voice. This module only resolves argv and fires the helper — it never blocks
 * the calling hook.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hollrHome } from "../core/config.ts";
import type { Platform } from "./index.ts";
import { spawnDetached } from "./index.ts";

const NODE_BIN = "node";
const READING_PIDFILE_NAME = "reading.pid";

/**
 * Absolute path to the bundled helper script. Resolved from this module's URL
 * so it is correct both under vitest (source tree) and in the published package,
 * where tsup emits `dist/index.js` and `scripts/helper/` ships beside `dist/`:
 * `../scripts/helper/...` from `dist/index.js` lands at `<pkg>/scripts/helper/`.
 */
export const HELPER_PATH: string = fileURLToPath(
  new URL("../scripts/helper/play-then-say.mjs", import.meta.url),
);

export interface SpeakSequencedOptions {
  text: string;
  voice: string | null;
  rateWpm: number;
  sound: string | null;
  platform: Platform;
}

/**
 * Resolve the sound and voice argv for `opts` and, if either is present, spawn
 * the detached helper to play then speak them in sequence. When both resolve to
 * `null` (nothing to play or say) this is a no-op.
 */
export function speakSequenced(opts: SpeakSequencedOptions): void {
  const soundArgv =
    opts.sound === null ? null : opts.platform.soundArgv(opts.sound);
  const voiceArgv = opts.platform.voiceArgv(opts.text, opts.voice, opts.rateWpm);
  if (soundArgv === null && voiceArgv === null) {
    return;
  }
  const pidPath = join(hollrHome(), READING_PIDFILE_NAME);
  const payload = JSON.stringify({ soundArgv, voiceArgv, pidPath });
  spawnDetached([NODE_BIN, HELPER_PATH, payload]);
}
