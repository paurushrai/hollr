"""hollr configuration: defaults, global + per-project merge, mute, quiet hours.

All loads are defensive — malformed or missing files contribute nothing and
never raise, because this runs inside a Claude Code hook that must not fail.
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path

CLAUDE_HOME = Path.home() / ".claude"

DEFAULTS: dict = {
    "version": 1,
    "events": {
        "done": {"mode": "announce"},
        "needs_input": {"mode": "announce"},
    },
    "voice": {"engine": "system", "name": "Samantha", "rate_wpm": 190},
    "notify": {"desktop": True},
    "readaloud": {"max_chars": 1200, "strip_code": True},
    "quiet_hours": None,
}

_NON_ALNUM = re.compile(r"[^A-Za-z0-9]")
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def encode_cwd(cwd: str) -> str:
    """Match Claude Code's project-dir encoding: non-alphanumerics become '-'."""
    return _NON_ALNUM.sub("-", cwd)


def project_config_dir(cwd: str) -> Path:
    return CLAUDE_HOME / "projects" / encode_cwd(cwd)


def global_config_path() -> Path:
    return CLAUDE_HOME / "hollr" / "config.json"


def global_config_exists() -> bool:
    return global_config_path().is_file()


def is_configured(cwd: str) -> bool:
    """Setup has run if the global config OR this project's override exists."""
    return global_config_exists() or (project_config_dir(cwd) / "hollr.json").is_file()


def hint_marker_path() -> Path:
    """Marker recording that the one-time '/hollr setup' hint was shown."""
    return CLAUDE_HOME / "hollr" / "hint-shown"


def _read_json(path: Path) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


_NESTED_KEYS = ("events", "voice", "notify", "readaloud")


def _merge(base: dict, override: dict) -> dict:
    """Top-level merge; known nested dicts merge one level deep so partial
    overrides (e.g. only events.done) keep the remaining defaults."""
    merged = dict(base)
    for key, value in override.items():
        if key in _NESTED_KEYS and isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def load_config(cwd: str) -> dict:
    """DEFAULTS <- global <- project."""
    merged = _merge(DEFAULTS, _read_json(global_config_path()))
    return _merge(merged, _read_json(project_config_dir(cwd) / "hollr.json"))


def is_muted(cwd: str) -> bool:
    return (project_config_dir(cwd) / "hollr-muted").exists()


def _minutes(part: str) -> int | None:
    match = _HHMM.match(part)
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def in_quiet_hours(quiet_hours: str | None, now: datetime.datetime) -> bool:
    """True when `now` falls in "HH:MM-HH:MM"; window may wrap midnight."""
    if not quiet_hours or "-" not in quiet_hours:
        return False
    start_raw, _, end_raw = quiet_hours.partition("-")
    start, end = _minutes(start_raw), _minutes(end_raw)
    if start is None or end is None:
        return False
    current = now.hour * 60 + now.minute
    if start <= end:
        return start <= current < end
    return current >= start or current < end
