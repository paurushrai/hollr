"""Detached macOS voice + notification sinks. Every call is fire-and-forget:
spawn failures are swallowed because this runs inside a Claude Code hook
that must never block or break the agent turn."""

from __future__ import annotations

import os
import re
import subprocess

MAX_SPEECH_CHARS = 2000
MAX_NOTIFY_BODY = 200
MAX_NOTIFY_TITLE = 60
DEFAULT_RATE_WPM = 190

# Values meaning "use the OS-configured default voice" instead of a named one.
SYSTEM_VOICE_SENTINELS = frozenset({"", "system", "default"})

SOUND_DIR = "/System/Library/Sounds"
_SOUND_NAME_RE = re.compile(r"^[A-Za-z]+$")
_PLAY_THEN_SAY = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "_play_then_say.py")
)


def _spawn(argv: list[str]) -> None:
    try:
        subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass  # missing binary / spawn failure must never surface into the hook


def _sound_path(name: str | None) -> str | None:
    """Resolve a bare macOS system sound name to its .aiff path. Only
    `^[A-Za-z]+$` names are accepted — anything else (path separators,
    `..`, shell metacharacters, empty string) returns None, which blocks
    path traversal and argument injection at the source."""
    if not name or not _SOUND_NAME_RE.match(name):
        return None
    path = f"{SOUND_DIR}/{name}.aiff"
    return path if os.path.isfile(path) else None


def play_sound(name: str | None) -> None:
    """Play a macOS system alert tone via `afplay`, detached. No-op if
    `name` doesn't resolve to a real sound file."""
    path = _sound_path(name)
    if path:
        _spawn(["afplay", path])


def speak(
    text: str,
    voice: str | None = None,
    rate_wpm: int = DEFAULT_RATE_WPM,
    sound: str | None = None,
) -> None:
    """Speak via the detached `_play_then_say.py` helper — always, even with
    no sound configured — so that PID tracking (for hotkey pause/resume/stop,
    see lib/control.py) and sound-then-voice sequencing happen in exactly one
    place. This call still returns immediately; the helper blocks internally.

    A non-numeric/None rate_wpm (e.g. hand-edited config) falls back to the
    default rate instead of raising — a bad voice setting must never
    suppress delivery.

    `voice` omitted, None, or one of SYSTEM_VOICE_SENTINELS (case-insensitive)
    means "use the OS-configured default voice" — the helper leaves `-v` off
    entirely so `say` picks it up itself.

    `sound`, when it resolves to a real system alert tone, plays fully
    BEFORE the voice starts — never simultaneously; otherwise the helper
    is still invoked with an empty sound argument, skipping playback."""
    if not text:
        return
    try:
        rate = int(rate_wpm)
    except (TypeError, ValueError):
        rate = DEFAULT_RATE_WPM

    sound_path = _sound_path(sound) or ""
    voice_arg = str(voice) if voice and str(voice).strip().lower() not in SYSTEM_VOICE_SENTINELS else ""
    _spawn(["python3", _PLAY_THEN_SAY, sound_path, voice_arg, str(rate), text[:MAX_SPEECH_CHARS]])


def _applescript_safe(text: str) -> str:
    """Neutralize AppleScript string escapes: drop backslashes, quotes -> '."""
    return text.replace("\\", "").replace('"', "'")


def notify(title: str, body: str) -> None:
    """Desktop notification via osascript, detached."""
    safe_body = _applescript_safe(body)[:MAX_NOTIFY_BODY]
    safe_title = _applescript_safe(title)[:MAX_NOTIFY_TITLE]
    script = f'display notification "{safe_body}" with title "{safe_title}"'
    _spawn(["osascript", "-e", script])
