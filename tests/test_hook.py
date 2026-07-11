import datetime
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from hooks import hollr_hook
from lib import config

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime.datetime(2026, 7, 11, 12, 0)
QUIET_NOW = datetime.datetime(2026, 7, 11, 23, 0)


def _payload(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _configured(tmp_path, monkeypatch, overrides: dict | None = None):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    (tmp_path / "hollr").mkdir(parents=True)
    (tmp_path / "hollr" / "config.json").write_text(json.dumps(overrides or {}))


def test_stop_announce_speaks_and_notifies(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch)
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_called_once()
    assert speak.call_args.args[0] == "Claude Code response is ready in my app"
    notify.assert_called_once_with("hollr", "Claude Code response is ready in my app")


def test_notification_announce_uses_needs_input_line(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch)
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify"):
        hollr_hook.handle(_payload("payload_notification.json"), NOW)
    assert speak.call_args.args[0] == "Claude Code needs your input in my app"


def test_no_config_prints_hint_once_with_exit_1(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        first = hollr_hook.handle(_payload("payload_stop.json"), NOW)
        err_first = capsys.readouterr().err
        second = hollr_hook.handle(_payload("payload_stop.json"), NOW)
        err_second = capsys.readouterr().err
    speak.assert_not_called()
    notify.assert_not_called()
    assert first == 1 and "/hollr setup" in err_first   # exit 1 -> Claude Code shows stderr
    assert second == 0 and err_second == ""              # marker file makes hint once-only


def test_project_scope_only_config_counts_as_configured(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    proj = tmp_path / "projects" / config.encode_cwd("/Users/me/dev/my-app")
    proj.mkdir(parents=True)
    (proj / "hollr.json").write_text("{}")
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify"):
        assert hollr_hook.handle(_payload("payload_stop.json"), NOW) == 0
    speak.assert_called_once()   # wizard project-scope setup must activate the plugin


def test_muted_project_is_fully_silent(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch)
    proj = tmp_path / "projects" / config.encode_cwd("/Users/me/dev/my-app")
    proj.mkdir(parents=True)
    (proj / "hollr-muted").touch()
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_not_called()
    notify.assert_not_called()


def test_quiet_hours_suppress_voice_but_allow_notify(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"quiet_hours": "22:00-08:00"})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), QUIET_NOW)
    speak.assert_not_called()
    notify.assert_called_once()


def test_silent_mode_does_nothing(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"events": {"done": {"mode": "silent"}, "needs_input": {"mode": "silent"}}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_not_called()
    notify.assert_not_called()


def test_notify_mode_notifies_without_voice(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"events": {"done": {"mode": "notify"}, "needs_input": {"mode": "notify"}}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_not_called()
    notify.assert_called_once()


def test_readaloud_reads_last_response(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"events": {"done": {"mode": "readaloud"}, "needs_input": {"mode": "announce"}}})
    transcript_file = tmp_path / "t.jsonl"
    transcript_file.write_text(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Refactor complete. All 42 tests pass."}]}}\n'
    )
    payload = _payload("payload_stop.json")
    payload["transcript_path"] = str(transcript_file)
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify"):
        hollr_hook.handle(payload, NOW)
    assert speak.call_args.args[0] == "Refactor complete. All 42 tests pass."


def test_readaloud_missing_transcript_falls_back_to_announce(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"events": {"done": {"mode": "readaloud"}, "needs_input": {"mode": "announce"}}})
    payload = _payload("payload_stop.json")
    payload["transcript_path"] = "/nonexistent.jsonl"
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify"):
        hollr_hook.handle(payload, NOW)
    assert speak.call_args.args[0] == "Claude Code response is ready in my app"


def test_readaloud_on_needs_input_downgrades_to_announce(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"events": {"done": {"mode": "announce"}, "needs_input": {"mode": "readaloud"}}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify"):
        hollr_hook.handle(_payload("payload_notification.json"), NOW)
    assert speak.call_args.args[0] == "Claude Code needs your input in my app"


def test_announce_respects_desktop_false(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"notify": {"desktop": False}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_called_once()
    notify.assert_not_called()


def test_sound_plays_before_voice_when_configured(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"notify": {"desktop": True, "sound": "Glass"}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_called_once()
    assert speak.call_args.kwargs.get("sound") == "Glass"
    notify.assert_called_once()


def test_quiet_hours_suppress_sound_and_voice_keep_notify(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"quiet_hours": "22:00-08:00", "notify": {"desktop": True, "sound": "Glass"}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify, \
         patch.object(hollr_hook.speech, "play_sound") as play_sound:
        hollr_hook.handle(_payload("payload_stop.json"), QUIET_NOW)
    speak.assert_not_called()
    play_sound.assert_not_called()
    notify.assert_called_once()


def test_notify_mode_with_sound_plays_sound_no_voice(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {
        "events": {"done": {"mode": "notify"}, "needs_input": {"mode": "notify"}},
        "notify": {"desktop": True, "sound": "Glass"},
    })
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify, \
         patch.object(hollr_hook.speech, "play_sound") as play_sound:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_not_called()
    play_sound.assert_called_once_with("Glass")
    notify.assert_called_once()


def test_unknown_event_or_bad_cwd_is_noop(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch)
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        assert hollr_hook.handle({"hook_event_name": "PreToolUse", "cwd": "/x"}, NOW) == 0
        assert hollr_hook.handle({"hook_event_name": "Stop"}, NOW) == 0
        assert hollr_hook.handle({"hook_event_name": "Stop", "cwd": 123}, NOW) == 0
        assert hollr_hook.handle({}, NOW) == 0
    speak.assert_not_called()
    notify.assert_not_called()


def test_type_wrong_config_never_raises(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch, {"events": "loud", "voice": {"rate_wpm": "fast"}})
    with patch.object(hollr_hook.speech, "speak"), \
         patch.object(hollr_hook.speech, "notify"):
        assert hollr_hook.handle(_payload("payload_stop.json"), NOW) == 0  # must not raise


def test_announce_with_bad_rate_still_notifies(tmp_path, monkeypatch):
    _configured(tmp_path, monkeypatch,
                {"voice": {"engine": "system", "name": "Samantha", "rate_wpm": "fast"}})
    with patch.object(hollr_hook.speech, "speak") as speak, \
         patch.object(hollr_hook.speech, "notify") as notify:
        hollr_hook.handle(_payload("payload_stop.json"), NOW)
    speak.assert_called_once()
    notify.assert_called_once()


def test_main_reads_stdin_and_never_raises_on_garbage(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))
    hollr_hook.main()   # must not raise, must not exit

    monkeypatch.setattr(sys, "stdin", io.StringIO("x" * (hollr_hook.MAX_PAYLOAD_BYTES + 10)))
    hollr_hook.main()   # oversized -> silent no-op


def test_main_dispatches_valid_payload_to_handle(monkeypatch):
    payload = _payload("payload_stop.json")
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    with patch.object(hollr_hook, "handle", return_value=0) as handle:
        with pytest.raises(SystemExit) as exc:
            hollr_hook.main()
    assert exc.value.code == 0
    assert handle.call_args.args[0] == payload
