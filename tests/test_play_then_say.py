import subprocess
from unittest.mock import patch

from hooks import _play_then_say


def test_sound_plays_before_voice():
    with patch.object(subprocess, "run") as mock_run:
        _play_then_say.main(["/System/Library/Sounds/Glass.aiff", "", "190", "done"])
    calls = mock_run.call_args_list
    assert len(calls) == 2
    first_argv = calls[0].args[0]
    second_argv = calls[1].args[0]
    assert first_argv[0] == "afplay"
    assert first_argv[1] == "/System/Library/Sounds/Glass.aiff"
    assert second_argv[0] == "say"


def test_no_sound_skips_afplay_and_includes_voice_flag():
    with patch.object(subprocess, "run") as mock_run:
        _play_then_say.main(["", "Alex", "190", "done"])
    calls = mock_run.call_args_list
    assert len(calls) == 1
    argv = calls[0].args[0]
    assert argv[0] == "say"
    assert "-v" in argv
    assert argv[argv.index("-v") + 1] == "Alex"


def test_non_numeric_rate_falls_back_to_default():
    with patch.object(subprocess, "run") as mock_run:
        _play_then_say.main(["", "", "fast", "done"])
    argv = mock_run.call_args_list[0].args[0]
    assert argv[argv.index("-r") + 1] == str(_play_then_say.DEFAULT_RATE_WPM)


def test_afplay_oserror_does_not_block_say():
    with patch.object(subprocess, "run", side_effect=[OSError("no afplay"), None]) as mock_run:
        _play_then_say.main(["/System/Library/Sounds/Glass.aiff", "", "190", "done"])
    assert mock_run.call_count == 2
    assert mock_run.call_args_list[1].args[0][0] == "say"


def test_say_oserror_is_swallowed():
    with patch.object(subprocess, "run", side_effect=OSError("no say")):
        _play_then_say.main(["", "", "190", "done"])  # must not raise
