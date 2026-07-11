#!/usr/bin/env python3
"""Blocking helper: play a sound, THEN speak — never concurrently.

Spawned detached by lib/speech.py (so the calling hook never blocks); this
process itself blocks on each subprocess.run in sequence, guaranteeing the
sound finishes before the voice starts.

argv contract (all positional, no flags, no shell):
    _play_then_say.py <sound_path_or_empty> <voice_or_empty> <rate> <text>
"""

from __future__ import annotations

import subprocess
import sys

DEFAULT_RATE_WPM = 190
MAX_SPEECH_CHARS = 2000
SYSTEM_VOICE_SENTINELS = frozenset({"", "system", "default"})


def main(argv: list[str]) -> None:
    sound_path, voice, rate_raw, text = argv[0], argv[1], argv[2], argv[3]

    if sound_path:
        try:
            subprocess.run(["afplay", sound_path])
        except OSError:
            pass  # missing binary must not block the voice from following

    try:
        rate = int(rate_raw)
    except (TypeError, ValueError):
        rate = DEFAULT_RATE_WPM

    say_argv = ["say"]
    if voice and voice.strip().lower() not in SYSTEM_VOICE_SENTINELS:
        say_argv += ["-v", voice]
    say_argv += ["-r", str(rate), "--", text[:MAX_SPEECH_CHARS]]
    try:
        subprocess.run(say_argv)
    except OSError:
        pass


if __name__ == "__main__":
    main(sys.argv[1:])
