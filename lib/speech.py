"""Detached macOS voice + notification sinks. Every call is fire-and-forget:
spawn failures are swallowed because this runs inside a Claude Code hook
that must never block or break the agent turn."""

from __future__ import annotations

import subprocess

MAX_SPEECH_CHARS = 2000
MAX_NOTIFY_BODY = 200
MAX_NOTIFY_TITLE = 60
DEFAULT_RATE_WPM = 190


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


def speak(text: str, voice: str = "Samantha", rate_wpm: int = DEFAULT_RATE_WPM) -> None:
    """Speak via macOS `say`, detached. `--` stops text becoming flags.
    A non-numeric/None rate_wpm (e.g. hand-edited config) falls back to the
    default rate instead of raising — a bad voice setting must never
    suppress delivery."""
    if not text:
        return
    try:
        rate = int(rate_wpm)
    except (TypeError, ValueError):
        rate = DEFAULT_RATE_WPM
    _spawn(["say", "-v", str(voice), "-r", str(rate), "--", text[:MAX_SPEECH_CHARS]])


def _applescript_safe(text: str) -> str:
    """Neutralize AppleScript string escapes: drop backslashes, quotes -> '."""
    return text.replace("\\", "").replace('"', "'")


def notify(title: str, body: str) -> None:
    """Desktop notification via osascript, detached."""
    safe_body = _applescript_safe(body)[:MAX_NOTIFY_BODY]
    safe_title = _applescript_safe(title)[:MAX_NOTIFY_TITLE]
    script = f'display notification "{safe_body}" with title "{safe_title}"'
    _spawn(["osascript", "-e", script])
