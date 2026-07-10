"""Extract the last assistant message from a Claude Code JSONL transcript
and prepare it for text-to-speech. Transcript content is untrusted input:
size-capped read, per-line defensive parsing, never raises."""

from __future__ import annotations

import json
import os
import re

MAX_TRANSCRIPT_BYTES = 2_000_000
CODE_BLOCK_PLACEHOLDER = " code block omitted. "

_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_WHITESPACE = re.compile(r"\s+")


def _read_tail(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - MAX_TRANSCRIPT_BYTES))
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def _assistant_text(line: str) -> str | None:
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or obj.get("type") != "assistant":
        return None
    message = obj.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return None
    texts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    joined = " ".join(text for text in texts if text).strip()
    return joined or None


def last_assistant_message(path: str | None) -> str | None:
    """Return the newest assistant text in the transcript, or None."""
    if not path:
        return None
    data = _read_tail(path)
    if data is None:
        return None
    for line in reversed(data.splitlines()):
        text = _assistant_text(line)
        if text:
            return text
    return None


def prepare_speech_text(text: str, max_chars: int = 1200, strip_code: bool = True) -> str:
    """Make raw markdown speakable: drop code, collapse whitespace, cap length."""
    if strip_code:
        text = _CODE_BLOCK.sub(CODE_BLOCK_PLACEHOLDER, text)
        text = text.replace("`", "")
    return _WHITESPACE.sub(" ", text).strip()[:max_chars]
