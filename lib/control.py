"""Read-aloud control: pause/resume/stop a running `say` process by PID.

No daemon, no new permissions — a pidfile plus POSIX signals. `bin/hollr-ctl`
calls pause()/resume()/stop() so a user can bind a macOS/Linux/Windows global
hotkey to a shell command that reaches into a detached `say` process started
by hooks/_play_then_say.py. Every operation is defensive: a missing or stale
pidfile must never raise, because this can run unattended from a hotkey.
"""

from __future__ import annotations

import os
import signal

from lib.config import CLAUDE_HOME

READING_PIDFILE = CLAUDE_HOME / "hollr" / "reading.pid"

_NOTHING_READING = "hollr: nothing is being read"


def write_pid(pid: int) -> None:
    """Record the PID of the `say` process currently reading. Never raises."""
    try:
        READING_PIDFILE.parent.mkdir(parents=True, exist_ok=True)
        READING_PIDFILE.write_text(str(pid), encoding="utf-8")
    except OSError:
        pass


def read_pid() -> int | None:
    """Return the tracked PID, or None if missing/empty/non-integer."""
    try:
        raw = READING_PIDFILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def clear_pid() -> None:
    """Remove the pidfile, if present. Never raises."""
    try:
        READING_PIDFILE.unlink()
    except OSError:
        pass


def _signal_reader(sig: int, success_message: str) -> str:
    """Send `sig` to the tracked PID. A dead/unsignalable PID means the
    pidfile is stale from a reading that already ended — clear it and report
    that nothing is being read, rather than raising."""
    pid = read_pid()
    if pid is None:
        return _NOTHING_READING
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        clear_pid()
        return _NOTHING_READING
    return success_message


def pause() -> str:
    """Suspend the in-progress reading (SIGSTOP)."""
    return _signal_reader(signal.SIGSTOP, "hollr: reading paused")


def resume() -> str:
    """Resume a paused reading (SIGCONT)."""
    return _signal_reader(signal.SIGCONT, "hollr: reading resumed")


def stop() -> str:
    """Terminate the in-progress reading (SIGTERM) and clear the pidfile."""
    message = _signal_reader(signal.SIGTERM, "hollr: reading stopped")
    if message == "hollr: reading stopped":
        clear_pid()
    return message
