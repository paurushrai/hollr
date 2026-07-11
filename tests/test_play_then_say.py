import subprocess
from unittest.mock import MagicMock

from hooks import _play_then_say
from lib import control

FAKE_PID = 4242


def _fake_popen_process() -> MagicMock:
    proc = MagicMock()
    proc.pid = FAKE_PID
    return proc


def test_sound_plays_before_voice_pid_tracked_before_wait_then_cleared(monkeypatch):
    order = []
    fake_proc = _fake_popen_process()
    fake_proc.wait.side_effect = lambda: order.append("wait")

    def fake_run(argv, **_kwargs):
        order.append(("afplay", argv))
        return MagicMock()

    def fake_popen(argv, **_kwargs):
        order.append(("popen", argv))
        return fake_proc

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(control, "write_pid", lambda pid: order.append(("write_pid", pid)))
    monkeypatch.setattr(control, "read_pid", lambda: FAKE_PID)
    monkeypatch.setattr(control, "clear_pid", lambda: order.append("clear_pid"))

    _play_then_say.main(["/System/Library/Sounds/Glass.aiff", "", "190", "done"])

    kinds = [item[0] if isinstance(item, tuple) else item for item in order]
    assert kinds == ["afplay", "popen", "write_pid", "wait", "clear_pid"]
    assert order[0][1][0] == "afplay"
    assert order[0][1][1] == "/System/Library/Sounds/Glass.aiff"
    assert order[1][1][0] == "say"
    assert order[2][1] == FAKE_PID


def test_no_sound_skips_afplay_and_includes_voice_flag(monkeypatch):
    fake_proc = _fake_popen_process()
    run_calls = []
    popen_calls = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **_k: run_calls.append(argv))
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **_k: (popen_calls.append(argv), fake_proc)[1])
    monkeypatch.setattr(control, "write_pid", lambda pid: None)
    monkeypatch.setattr(control, "read_pid", lambda: FAKE_PID)
    monkeypatch.setattr(control, "clear_pid", lambda: None)

    _play_then_say.main(["", "Alex", "190", "done"])

    assert run_calls == []  # no sound -> no afplay
    argv = popen_calls[0]
    assert argv[0] == "say"
    assert "-v" in argv
    assert argv[argv.index("-v") + 1] == "Alex"


def test_non_numeric_rate_falls_back_to_default(monkeypatch):
    fake_proc = _fake_popen_process()
    popen_calls = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **_k: None)
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **_k: (popen_calls.append(argv), fake_proc)[1])
    monkeypatch.setattr(control, "write_pid", lambda pid: None)
    monkeypatch.setattr(control, "read_pid", lambda: FAKE_PID)
    monkeypatch.setattr(control, "clear_pid", lambda: None)

    _play_then_say.main(["", "", "fast", "done"])

    argv = popen_calls[0]
    assert argv[argv.index("-r") + 1] == str(_play_then_say.DEFAULT_RATE_WPM)


def test_afplay_oserror_does_not_block_say(monkeypatch):
    fake_proc = _fake_popen_process()
    popen_calls = []

    def raising_run(argv, **_k):
        raise OSError("no afplay")

    monkeypatch.setattr(subprocess, "run", raising_run)
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **_k: (popen_calls.append(argv), fake_proc)[1])
    monkeypatch.setattr(control, "write_pid", lambda pid: None)
    monkeypatch.setattr(control, "read_pid", lambda: FAKE_PID)
    monkeypatch.setattr(control, "clear_pid", lambda: None)

    _play_then_say.main(["/System/Library/Sounds/Glass.aiff", "", "190", "done"])

    assert popen_calls and popen_calls[0][0] == "say"


def test_say_oserror_is_swallowed(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda argv, **_k: None)

    def raising_popen(argv, **_k):
        raise OSError("no say")

    monkeypatch.setattr(subprocess, "Popen", raising_popen)
    write_pid_calls = []
    monkeypatch.setattr(control, "write_pid", lambda pid: write_pid_calls.append(pid))

    _play_then_say.main(["", "", "190", "done"])  # must not raise
    assert write_pid_calls == []  # no process spawned -> nothing to track


def test_clear_pid_skipped_when_pidfile_now_tracks_a_newer_reading(monkeypatch):
    fake_proc = _fake_popen_process()
    clear_calls = []
    monkeypatch.setattr(subprocess, "run", lambda argv, **_k: None)
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **_k: fake_proc)
    monkeypatch.setattr(control, "write_pid", lambda pid: None)
    monkeypatch.setattr(control, "read_pid", lambda: 9999)  # a newer reading started
    monkeypatch.setattr(control, "clear_pid", lambda: clear_calls.append(True))

    _play_then_say.main(["", "", "190", "done"])

    assert clear_calls == []
