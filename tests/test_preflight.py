import io
import json
import sys
from unittest.mock import patch

import pytest

from hooks import preflight
from lib import config, doctor


def _startup_payload(**overrides) -> dict:
    payload = {
        "hook_event_name": "SessionStart",
        "cwd": "/Users/me/dev/my-app",
        "session_id": "abc123",
        "source": "startup",
    }
    payload.update(overrides)
    return payload


def _fake_checks(all_ok: bool):
    if all_ok:
        return [doctor.Check(key="os", label="macOS", ok=True, required=True, detail=None, fix=None)]
    return [
        doctor.Check(key="os", label="macOS", ok=True, required=True, detail=None, fix=None),
        doctor.Check(
            key="python3",
            label="Python 3",
            ok=False,
            required=True,
            detail=None,
            fix="xcode-select --install",
        ),
    ]


def test_non_startup_source_returns_none_and_no_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", tmp_path / "hollr" / "preflight-ok")
    with patch.object(preflight.doctor, "check_all") as check_all:
        result = preflight.build_message(_startup_payload(source="resume"))
    assert result is None
    assert not preflight.PREFLIGHT_MARKER.exists()
    check_all.assert_not_called()


def test_marker_already_exists_returns_none_without_running_checks(tmp_path, monkeypatch):
    marker = tmp_path / "hollr" / "preflight-ok"
    marker.parent.mkdir(parents=True)
    marker.touch()
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", marker)
    with patch.object(preflight.doctor, "check_all") as check_all:
        result = preflight.build_message(_startup_payload())
    assert result is None
    check_all.assert_not_called()


def test_all_required_ok_creates_marker_and_returns_none(tmp_path, monkeypatch):
    marker = tmp_path / "hollr" / "preflight-ok"
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", marker)
    with patch.object(preflight.doctor, "check_all", return_value=_fake_checks(True)), \
         patch.object(preflight.doctor, "all_required_ok", return_value=True):
        result = preflight.build_message(_startup_payload())
    assert result is None
    assert marker.exists()


def test_missing_required_check_returns_message_and_no_marker(tmp_path, monkeypatch):
    marker = tmp_path / "hollr" / "preflight-ok"
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", marker)
    checks = _fake_checks(False)
    with patch.object(preflight.doctor, "check_all", return_value=checks), \
         patch.object(preflight.doctor, "all_required_ok", return_value=False):
        result = preflight.build_message(_startup_payload())
    assert result is not None
    assert "Python 3" in result
    assert "xcode-select --install" in result
    assert "Run /hollr doctor for details." in result
    assert not marker.exists()


def test_malformed_payload_returns_none_without_raising(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", tmp_path / "hollr" / "preflight-ok")
    assert preflight.build_message({}) is None
    assert preflight.build_message(None) is None  # type: ignore[arg-type]


def test_build_message_never_raises_on_doctor_error(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", tmp_path / "hollr" / "preflight-ok")
    with patch.object(preflight.doctor, "check_all", side_effect=RuntimeError("boom")):
        assert preflight.build_message(_startup_payload()) is None


def test_main_prints_system_message_with_missing_prereqs_and_exits_0(tmp_path, monkeypatch, capsys):
    marker = tmp_path / "hollr" / "preflight-ok"
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", marker)
    checks = _fake_checks(False)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(_startup_payload())))
    with patch.object(preflight.doctor, "check_all", return_value=checks), \
         patch.object(preflight.doctor, "all_required_ok", return_value=False):
        with pytest.raises(SystemExit) as exc:
            preflight.main()
    assert exc.value.code == 0
    out = json.loads(capsys.readouterr().out)
    assert "Python 3" in out["systemMessage"]
    assert not marker.exists()


def test_main_prints_nothing_when_message_is_none(tmp_path, monkeypatch, capsys):
    marker = tmp_path / "hollr" / "preflight-ok"
    monkeypatch.setattr(preflight, "PREFLIGHT_MARKER", marker)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(_startup_payload(source="resume"))))
    with pytest.raises(SystemExit) as exc:
        preflight.main()
    assert exc.value.code == 0
    assert capsys.readouterr().out == ""


def test_main_never_raises_on_garbage_stdin(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))
    with pytest.raises(SystemExit) as exc:
        preflight.main()
    assert exc.value.code == 0

    monkeypatch.setattr(sys, "stdin", io.StringIO("x" * (preflight.MAX_PAYLOAD_BYTES + 10)))
    with pytest.raises(SystemExit) as exc:
        preflight.main()
    assert exc.value.code == 0
