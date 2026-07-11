import os
import subprocess
from unittest.mock import patch

from lib import speech


def _popen_argv(mock_popen) -> list:
    return mock_popen.call_args.args[0]


def test_speak_builds_say_argv_with_flag_guard():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("hello world", voice="Alex", rate_wpm=200)
    argv = _popen_argv(mock_popen)
    assert argv[:5] == ["say", "-v", "Alex", "-r", "200"]
    assert argv[5] == "--"          # user-derived text can never become a flag
    assert argv[6] == "hello world"


def test_speak_detaches_and_silences_output():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("hi")
    kwargs = mock_popen.call_args.kwargs
    assert kwargs["start_new_session"] is True
    assert kwargs["stdout"] == subprocess.DEVNULL
    assert kwargs["stderr"] == subprocess.DEVNULL


def test_speak_empty_text_is_noop():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("")
    mock_popen.assert_not_called()


def test_speak_caps_text_length():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("a" * 10_000)
    assert len(_popen_argv(mock_popen)[-1]) == speech.MAX_SPEECH_CHARS


def test_notify_builds_osascript_argv():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.notify("hollr", "response ready")
    argv = _popen_argv(mock_popen)
    assert argv[0] == "osascript"
    assert argv[1] == "-e"
    assert 'display notification "response ready" with title "hollr"' == argv[2]


def test_notify_sanitizes_quotes_and_backslashes():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.notify('a"b\\c', 'x"y')
    script = _popen_argv(mock_popen)[2]
    assert "\\" not in script
    assert script == "display notification \"x'y\" with title \"a'bc\""


def test_spawn_failure_is_swallowed():
    with patch.object(subprocess, "Popen", side_effect=OSError("no binary")):
        speech.speak("hi")   # must not raise
        speech.notify("t", "b")


def test_speak_tolerates_non_numeric_rate():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("hi", rate_wpm="fast")   # must not raise
    argv = _popen_argv(mock_popen)
    assert argv[argv.index("-r") + 1] == str(speech.DEFAULT_RATE_WPM)

    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("hi", rate_wpm=None)   # must not raise
    argv = _popen_argv(mock_popen)
    assert argv[argv.index("-r") + 1] == str(speech.DEFAULT_RATE_WPM)


def test_speak_system_default_omits_voice_flag():
    for kwargs in ({}, {"voice": None}, {"voice": "system"}, {"voice": ""}):
        with patch.object(subprocess, "Popen") as mock_popen:
            speech.speak("hi", **kwargs)
        assert "-v" not in _popen_argv(mock_popen)

    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("hi", voice="Alex")
    assert "-v" in _popen_argv(mock_popen)


def test_sound_path_sanitizes():
    expected = f"{speech.SOUND_DIR}/Glass.aiff"
    if os.path.isfile(expected):
        assert speech._sound_path("Glass") == expected
    else:
        assert speech._sound_path("Glass") is None
    assert speech._sound_path("../../etc/passwd") is None
    assert speech._sound_path("Glass; rm") is None
    assert speech._sound_path("") is None


def test_speak_with_sound_routes_through_helper():
    fake_path = f"{speech.SOUND_DIR}/Glass.aiff"
    with patch.object(subprocess, "Popen") as mock_popen, \
         patch.object(speech, "_sound_path", return_value=fake_path):
        speech.speak("hi", voice="Alex", rate_wpm=200, sound="Glass")
    argv = _popen_argv(mock_popen)
    assert argv[0] == "python3"
    assert argv[1].endswith("_play_then_say.py")
    assert argv[2] == fake_path
    assert argv[3] == "Alex"
    assert argv[4] == "200"
    assert argv[5] == "hi"


def test_speak_without_sound_uses_say_directly():
    with patch.object(subprocess, "Popen") as mock_popen:
        speech.speak("hi")
    argv = _popen_argv(mock_popen)
    assert argv[0] == "say"


def test_play_sound_spawns_afplay():
    fake_path = f"{speech.SOUND_DIR}/Glass.aiff"
    with patch.object(subprocess, "Popen") as mock_popen, \
         patch.object(speech, "_sound_path", return_value=fake_path):
        speech.play_sound("Glass")
    argv = _popen_argv(mock_popen)
    assert argv == ["afplay", fake_path]

    with patch.object(subprocess, "Popen") as mock_popen, \
         patch.object(speech, "_sound_path", return_value=None):
        speech.play_sound("nope; rm")
    mock_popen.assert_not_called()
