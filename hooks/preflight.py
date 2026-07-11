#!/usr/bin/env python3
"""hollr hook entrypoint for Claude Code SessionStart events.

Surfaces missing prerequisites (reusing `lib/doctor.py`) to the user right
after install, with no command required. Fires only on a fresh session
start ("source": "startup" — not resume/clear/compact), nags once per
startup until every required check passes, then writes a marker file and
goes silent permanently. Every failure path is a silent no-op: a hook must
never block or break session start.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import config, doctor  # noqa: E402

MAX_PAYLOAD_BYTES = 1_000_000

PREFLIGHT_MARKER = config.CLAUDE_HOME / "hollr" / "preflight-ok"


def _format_message(checks: list) -> str:
    missing = [c for c in checks if c.required and not c.ok]
    labels = ", ".join(c.label for c in missing)
    lines = [f"hollr: missing prerequisite(s): {labels}"]
    for check in missing:
        if check.fix:
            lines.append(f"  fix: {check.fix}")
    lines.append("  Run /hollr doctor for details.")
    return "\n".join(lines)


def _mark_satisfied() -> None:
    PREFLIGHT_MARKER.parent.mkdir(parents=True, exist_ok=True)
    PREFLIGHT_MARKER.touch()


def _build_message(payload: dict) -> str | None:
    if payload.get("source") != "startup":
        return None
    if PREFLIGHT_MARKER.exists():
        return None
    checks = doctor.check_all()
    if doctor.all_required_ok(checks):
        _mark_satisfied()
        return None
    return _format_message(checks)


def build_message(payload: dict | None) -> str | None:
    """Crash-proof seam: untrusted payload must never break the hook."""
    try:
        if not isinstance(payload, dict):
            return None
        return _build_message(payload)
    except Exception:  # noqa: BLE001 — hook failures are mandated silent no-ops
        return None


def main() -> None:
    try:
        raw = sys.stdin.read(MAX_PAYLOAD_BYTES + 1)
        if len(raw) > MAX_PAYLOAD_BYTES:
            sys.exit(0)
        payload = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        sys.exit(0)
    message = build_message(payload)
    if message:
        print(json.dumps({"systemMessage": message}))
    sys.exit(0)


if __name__ == "__main__":
    main()
