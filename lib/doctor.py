"""Prerequisite checks for hollr.

`check_all()` inspects the host machine for the binaries and OS hollr v1
needs (macOS voice + notifications) and returns one `Check` per
prerequisite, each with a copy-paste `fix` command where one exists.
Stdlib only, no network, never raises — `bin/hollr-doctor` and
`/hollr doctor` / `/hollr setup` all depend on this being safe to call
unconditionally on any machine, including ones missing everything.
"""

from __future__ import annotations

import platform
import shutil
from dataclasses import dataclass

_XCODE_SELECT_FIX = "xcode-select --install"
_CLAUDE_DOCS_FIX = "See https://docs.claude.com/en/docs/claude-code for install"
_MACOS_ONLY_DETAIL = (
    "hollr v1 voice + notifications are macOS-only (Linux/Windows = v2 roadmap)"
)


@dataclass(frozen=True)
class Check:
    """One prerequisite's result. `fix` is a copy-paste command, or None
    when there's nothing actionable to run (e.g. built-in macOS tools that
    are only absent because the OS itself isn't macOS)."""

    key: str
    label: str
    ok: bool
    required: bool
    detail: str | None
    fix: str | None


def _check_os() -> Check:
    is_darwin = platform.system() == "Darwin"
    return Check(
        key="os",
        label="macOS",
        ok=is_darwin,
        required=True,
        detail=None if is_darwin else _MACOS_ONLY_DETAIL,
        fix=None,
    )


def _check_binary(
    key: str, label: str, *, required: bool, fix: str | None
) -> Check:
    ok = shutil.which(key) is not None
    return Check(key=key, label=label, ok=ok, required=required, detail=None, fix=fix)


def check_all() -> list[Check]:
    """Run every prerequisite check. Never raises."""
    return [
        _check_os(),
        _check_binary("python3", "Python 3", required=True, fix=_XCODE_SELECT_FIX),
        _check_binary("say", "say (voice)", required=True, fix=None),
        _check_binary("osascript", "osascript (notifications)", required=True, fix=None),
        _check_binary("afplay", "afplay (optional alert sound)", required=False, fix=None),
        _check_binary("claude", "claude CLI (Claude Code)", required=False, fix=_CLAUDE_DOCS_FIX),
    ]


def all_required_ok(checks: list[Check]) -> bool:
    """True if every required check passed."""
    return all(c.ok for c in checks if c.required)
