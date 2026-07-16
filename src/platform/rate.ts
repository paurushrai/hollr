/**
 * Shared speech-rate helpers. `coerceRate` is used by every engine that passes
 * a words-per-minute value straight to a binary (darwin `say`, linux espeak);
 * `rateToSpd` is the linux `spd-say` mapping. Platform-specific mappings that
 * are not shared (win32's -10..10 scale) live in their own engine files.
 */

/** kelbrin's default speaking rate, in words per minute. */
export const DEFAULT_RATE_WPM = 190;

/** `spd-say -r` bounds and baseline: 150→-40, 190→0, 220→+30 (slope 1/wpm). */
const SPD_BASELINE_WPM = DEFAULT_RATE_WPM;
const SPD_RATE_MIN = -100;
const SPD_RATE_MAX = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A hand-edited config can carry a bad rate; fall back instead of emitting `NaN`. */
export function coerceRate(rateWpm: number): number {
  return Number.isFinite(rateWpm) ? Math.trunc(rateWpm) : DEFAULT_RATE_WPM;
}

/**
 * Map words-per-minute to the `spd-say -r` scale (linear, slope 1 wpm/point,
 * clamped to [-100, 100]). A non-finite rate yields the neutral `"0"`.
 */
export function rateToSpd(rateWpm: number): string {
  if (!Number.isFinite(rateWpm)) {
    return "0";
  }
  const points = Math.round(rateWpm - SPD_BASELINE_WPM);
  return String(clamp(points, SPD_RATE_MIN, SPD_RATE_MAX));
}
