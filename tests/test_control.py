import signal
from unittest.mock import patch

from lib import control


def _use_tmp_pidfile(monkeypatch, tmp_path):
    monkeypatch.setattr(control, "READING_PIDFILE", tmp_path / "hollr" / "reading.pid")


def test_read_pid_none_when_missing(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    assert control.read_pid() is None


def test_read_pid_none_on_garbage_content(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.READING_PIDFILE.parent.mkdir(parents=True)
    control.READING_PIDFILE.write_text("not-a-pid", encoding="utf-8")
    assert control.read_pid() is None


def test_read_pid_none_on_empty_content(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.READING_PIDFILE.parent.mkdir(parents=True)
    control.READING_PIDFILE.write_text("", encoding="utf-8")
    assert control.read_pid() is None


def test_write_pid_then_read_pid_round_trip(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(4242)
    assert control.read_pid() == 4242


def test_write_pid_creates_parent_dir(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    assert not control.READING_PIDFILE.parent.exists()
    control.write_pid(1)
    assert control.READING_PIDFILE.parent.is_dir()


def test_clear_pid_removes_existing_file(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(1)
    control.clear_pid()
    assert not control.READING_PIDFILE.exists()


def test_clear_pid_missing_file_does_not_raise(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.clear_pid()  # must not raise


def test_pause_sends_sigstop_to_live_pid(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(4242)
    with patch("os.kill") as mock_kill:
        result = control.pause()
    mock_kill.assert_called_once_with(4242, signal.SIGSTOP)
    assert result == "hollr: reading paused"
    assert control.read_pid() == 4242  # pause does not clear the pidfile


def test_resume_sends_sigcont_to_live_pid(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(4242)
    with patch("os.kill") as mock_kill:
        result = control.resume()
    mock_kill.assert_called_once_with(4242, signal.SIGCONT)
    assert result == "hollr: reading resumed"


def test_stop_sends_sigterm_and_clears_pidfile(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(4242)
    with patch("os.kill") as mock_kill:
        result = control.stop()
    mock_kill.assert_called_once_with(4242, signal.SIGTERM)
    assert result == "hollr: reading stopped"
    assert control.read_pid() is None


def test_pause_with_no_pid_reports_nothing_reading(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    assert control.pause() == "hollr: nothing is being read"


def test_pause_with_stale_pid_clears_file_and_reports_nothing_reading(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(9999)
    with patch("os.kill", side_effect=ProcessLookupError):
        result = control.pause()
    assert result == "hollr: nothing is being read"
    assert control.read_pid() is None


def test_resume_with_stale_pid_clears_file_and_reports_nothing_reading(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(9999)
    with patch("os.kill", side_effect=PermissionError):
        result = control.resume()
    assert result == "hollr: nothing is being read"
    assert control.read_pid() is None


def test_stop_with_stale_pid_clears_file_and_reports_nothing_reading(monkeypatch, tmp_path):
    _use_tmp_pidfile(monkeypatch, tmp_path)
    control.write_pid(9999)
    with patch("os.kill", side_effect=OSError):
        result = control.stop()
    assert result == "hollr: nothing is being read"
    assert control.read_pid() is None


def test_control_functions_never_raise_on_unwritable_pidfile(monkeypatch, tmp_path):
    # Parent is a file, not a dir -> mkdir/write_text must fail silently.
    blocker = tmp_path / "hollr"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setattr(control, "READING_PIDFILE", blocker / "reading.pid")
    control.write_pid(1)   # must not raise
    assert control.read_pid() is None
    control.clear_pid()    # must not raise
