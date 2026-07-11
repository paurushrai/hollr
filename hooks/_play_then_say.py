#!/usr/bin/env python3
"""Blocking helper: play a sound, THEN speak — never concurrently.

Spawned detached by lib/speech.py (so the calling hook never blocks); this
process itself blocks on each subprocess call in sequence, guaranteeing the
sound finishes before the voice starts. It also tracks the `say` PID in a
pidfile (lib/control.py) so a user-bound hotkey (bin/hollr-ctl) can pause,
resume, or stop the reading in progress.

argv contract (all positional, no flags, no shell):
    _play_then_say.py <sound_path_or_empty> <voice_or_empty> <rate> <text>
"""

from __future__ import annotations

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import control  # noqa: E402

DEFAULT_RATE_WPM = 190
MAX_SPEECH_CHARS = 2000
SYSTEM_VOICE_SENTINELS = frozenset({"", "system", "default"})


def _play_sound(sound_path: str) -> None:
    if not sound_path:
        return
    try:
        subprocess.run(["afplay", sound_path])
    except OSError:
        pass  # missing binary must not block the voice from following


def _say(voice: str, rate: int, text: str) -> None:
    """Spawn `say`, track its PID for the duration, then untrack it — unless
    the pidfile has since moved on to a newer reading (guard against a race
    with the next utterance clobbering its own tracking)."""
    say_argv = ["say"]
    if voice and voice.strip().lower() not in SYSTEM_VOICE_SENTINELS:
        say_argv += ["-v", voice]
    say_argv += ["-r", str(rate), "--", text[:MAX_SPEECH_CHARS]]

    try:
        proc = subprocess.Popen(say_argv)
    except OSError:
        return  # missing binary: nothing to track

    control.write_pid(proc.pid)
    try:
        proc.wait()
    finally:
        if control.read_pid() == proc.pid:
            control.clear_pid()


def main(argv: list[str]) -> None:
    sound_path, voice, rate_raw, text = argv[0], argv[1], argv[2], argv[3]
    _play_sound(sound_path)
    try:
        rate = int(rate_raw)
    except (TypeError, ValueError):
        rate = DEFAULT_RATE_WPM
    _say(voice, rate, text)


if __name__ == "__main__":
    main(sys.argv[1:])
