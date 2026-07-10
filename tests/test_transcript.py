from pathlib import Path

from lib import transcript

FIXTURE = Path(__file__).parent / "fixtures" / "transcript_sample.jsonl"


def test_last_assistant_message_returns_final_assistant_text():
    assert transcript.last_assistant_message(str(FIXTURE)) == "All done. Tests pass."


def test_last_assistant_message_missing_file_returns_none():
    assert transcript.last_assistant_message("/nonexistent/x.jsonl") is None


def test_last_assistant_message_none_path_returns_none():
    assert transcript.last_assistant_message(None) is None


def test_last_assistant_message_skips_malformed_lines(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"good"}]}}\n'
        "{broken json\n"
    )
    assert transcript.last_assistant_message(str(p)) == "good"


def test_last_assistant_message_no_assistant_lines(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text('{"type":"user","message":{"content":[]}}\n')
    assert transcript.last_assistant_message(str(p)) is None


def test_prepare_speech_text_strips_code_blocks():
    text = "Fixed it.\n```python\nprint('hi')\n```\nAll tests pass."
    out = transcript.prepare_speech_text(text)
    assert "print" not in out
    assert out == "Fixed it. code block omitted. All tests pass."


def test_prepare_speech_text_keeps_code_when_disabled():
    text = "Run `ls` now"
    assert "ls" in transcript.prepare_speech_text(text, strip_code=False)


def test_prepare_speech_text_caps_length():
    out = transcript.prepare_speech_text("a" * 5000, max_chars=100)
    assert len(out) == 100


def test_prepare_speech_text_collapses_whitespace():
    assert transcript.prepare_speech_text("a\n\n  b\tc") == "a b c"
