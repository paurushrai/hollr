#!/usr/bin/env python3
"""hollr hook entrypoint for Claude Code Stop + Notification events.

Reads the hook JSON payload on stdin, decides the configured mode for the
event, and fires voice / desktop notification. Every failure path is a
silent no-op: a hook must never block or break the agent turn.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import config, speech, transcript  # noqa: E402

MAX_PAYLOAD_BYTES = 1_000_000
TITLE = "hollr"

EVENT_KEYS = {"Stop": "done", "Notification": "needs_input"}
LINES = {
    "done": "Claude Code response is ready in {project}",
    "needs_input": "Claude Code needs your input in {project}",
}


def project_label(cwd: str) -> str:
    base = os.path.basename(cwd.rstrip("/\\")) or cwd
    return base.replace("-", " ").replace("_", " ")


def _readaloud_text(payload: dict, cfg: dict) -> str | None:
    raw = transcript.last_assistant_message(payload.get("transcript_path"))
    if not raw:
        return None
    opts = cfg.get("readaloud", {})
    return transcript.prepare_speech_text(
        raw,
        max_chars=int(opts.get("max_chars", 1200)),
        strip_code=bool(opts.get("strip_code", True)),
    )


def _deliver(mode: str, line: str, spoken: str, cfg: dict, quiet: bool) -> None:
    voice = cfg.get("voice", {})
    desktop = bool(cfg.get("notify", {}).get("desktop", True))
    if mode in ("announce", "readaloud") and not quiet:
        speech.speak(spoken, voice=voice.get("name"),
                     rate_wpm=voice.get("rate_wpm", 190))
    if mode == "notify" or ((mode in ("announce", "readaloud")) and desktop):
        speech.notify(TITLE, line)


def _hint_once() -> int:
    """First unconfigured event: print the setup hint and return exit code 1
    (non-blocking, non-2 — the code Claude Code surfaces stderr to the user
    for). A marker file makes this once-only."""
    marker = config.hint_marker_path()
    if marker.exists():
        return 0
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        return 0
    print("hollr: not configured — run /hollr setup", file=sys.stderr)
    return 1


def _handle(payload: dict, now: datetime.datetime) -> int:
    event_key = EVENT_KEYS.get(payload.get("hook_event_name", ""))
    cwd = payload.get("cwd") or ""
    if not event_key or not isinstance(cwd, str) or not cwd:
        return 0
    if not config.is_configured(cwd):
        return _hint_once()
    if config.is_muted(cwd):
        return 0
    cfg = config.load_config(cwd)
    events = cfg.get("events")
    mode = events.get(event_key, {}).get("mode", "silent") if isinstance(events, dict) else "silent"
    if mode not in ("announce", "readaloud", "notify"):
        return 0
    if mode == "readaloud" and event_key != "done":
        mode = "announce"  # readaloud only makes sense once the turn is over
    line = LINES[event_key].format(project=project_label(cwd))
    spoken = line
    if mode == "readaloud":
        spoken = _readaloud_text(payload, cfg) or line
    quiet = config.in_quiet_hours(cfg.get("quiet_hours"), now)
    _deliver(mode, line, spoken, cfg, quiet)
    return 0


def handle(payload: dict, now: datetime.datetime) -> int:
    """Crash-proof seam: untrusted payload/config must never break the hook."""
    try:
        return _handle(payload, now)
    except Exception:  # noqa: BLE001 — hook failures are mandated silent no-ops
        return 0


def main() -> None:
    try:
        raw = sys.stdin.read(MAX_PAYLOAD_BYTES + 1)
        if len(raw) > MAX_PAYLOAD_BYTES:
            return
        payload = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return
    if isinstance(payload, dict):
        sys.exit(handle(payload, datetime.datetime.now()))


if __name__ == "__main__":
    main()
