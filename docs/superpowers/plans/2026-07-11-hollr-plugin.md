# hollr Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship hollr v0.1.0 — a self-contained Claude Code plugin that announces "done" (Stop hook) and "needs-input" (Notification hook) via macOS voice, read-aloud, and/or desktop notification, configured by a `/hollr setup` wizard.

**Architecture:** A single Python hook entrypoint (`hooks/hollr_hook.py`) reads the hook JSON payload on stdin, branches on `hook_event_name`, and delegates to three focused libs: `lib/config.py` (defaults + global + per-project merge, mute flag, quiet hours), `lib/transcript.py` (extract last assistant message for read-aloud), `lib/speech.py` (detached `say` / `osascript` subprocesses). A `/hollr` slash command handles toggle + setup wizard. Zero runtime dependencies; pytest for tests.

**Tech Stack:** Python 3 (stdlib only), pytest + pytest-cov (dev only), Claude Code plugin manifest (`.claude-plugin/plugin.json`), macOS `say` + `osascript`.

**Model strategy (user-mandated):** Planning + plan verification on Fable 5 (this session). Implementation subagents dispatched with `model: "opus"`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-11-hollr-plugin-design.md` — plan implements it exactly.
- Repo: **`paurushrai/hollr`** on GitHub. `gh` currently authed as `paurush-rai` — must re-auth/switch to `paurushrai` before repo creation (Task 1).
- Git: incremental commits on `main`, **linear history** (no merge commits). Conventional Commits (`type(scope): summary`). Every commit: tests pass. Author identity: Paurush Rai <paurushrai99@gmail.com>. **No `Co-Authored-By` trailers of any kind.**
- v1 is macOS-only (`say`, `osascript`). Linux/Windows = v2 roadmap, do NOT implement.
- Neural voice = v3 roadmap: wizard offers it but config value `"neural"` falls back to system voice at runtime.
- Fully local: no network calls anywhere in v1.
- Security: argv arrays only, no shell interpolation, no `eval`. All external input (payload, transcript, config) parsed defensively, size-capped. `say` gets `--` before user-derived text.
- Zero coupling to legacy scripts (`~/.claude/tools/*.py`) or legacy flags (`speech-paused`). hollr uses its own files: `~/.claude/hollr/config.json`, `~/.claude/projects/<encoded>/hollr.json`, `~/.claude/projects/<encoded>/hollr-muted`.
- Code limits: fn ≤ 40 lines, file ≤ 400 lines, explicit error handling, named constants.
- Coverage ≥ 80% (`pytest --cov`).
- All hook failures must be silent no-ops — a hook must never block or break the agent.

**Canonical spoken lines (copy verbatim):**
- done: `Claude Code response is ready in <project>`
- needs_input: `Claude Code needs your input in <project>`

**Config schema v1 (source of truth for all tasks):**

```json
{
  "version": 1,
  "events": {
    "done":        { "mode": "announce" },
    "needs_input": { "mode": "announce" }
  },
  "voice": { "engine": "system", "name": "Samantha", "rate_wpm": 190 },
  "notify": { "desktop": true },
  "readaloud": { "max_chars": 1200, "strip_code": true },
  "quiet_hours": null
}
```

Modes: `announce` | `readaloud` | `notify` | `silent` (readaloud valid for `done` only; if set on `needs_input`, treat as `announce`).

---

### Task 1: Repository bootstrap + doc reorganization

**Files:**
- Create: `.gitignore`
- Move: `README.md`, `SPEC.md`, `PLAN.md`, `LAUNCH.md` → `docs/product/`
- Existing kept in place: `docs/superpowers/specs/`, `docs/superpowers/plans/`

**Interfaces:**
- Produces: a pushed `paurushrai/hollr` GitHub repo with linear `main`, docs reorganized, working tree at repo root `/Users/paurushrai/Developer/personal/hollr`.

- [ ] **Step 1: Verify gh is authed as `paurushrai`**

Run: `gh auth status`
Expected: `✓ Logged in to github.com account paurushrai` marked Active.

If it shows only `paurush-rai`: STOP and ask the user to run `! gh auth login` (interactive, they must do it) or `gh auth switch --user paurushrai` if the account is already on the keyring. Do not proceed until active account is `paurushrai`.

- [ ] **Step 2: git init + identity + .gitignore**

```bash
cd /Users/paurushrai/Developer/personal/hollr
git init -b main
git config user.name "Paurush Rai"
git config user.email "paurushrai99@gmail.com"
```

Create `.gitignore`:

```gitignore
__pycache__/
*.pyc
.pytest_cache/
.coverage
htmlcov/
.DS_Store
.claude/settings.local.json

# Earshot product go-to-market docs — kept local, NOT published (public repo)
docs/product/
```

- [ ] **Step 3: Move product docs into docs/product/**

```bash
mkdir -p docs/product
mv README.md SPEC.md PLAN.md LAUNCH.md docs/product/
```

(Plain `mv` — files aren't tracked yet.)

- [ ] **Step 4: First commit (docs only)**

```bash
git add .gitignore docs/
git commit -m "chore: bootstrap repo with plugin spec and implementation plan"
```

Expected: one commit on `main`. Verify `docs/product/` is NOT staged:
`git status --porcelain docs/product/` prints nothing (it is gitignored,
files remain on disk locally). `git log --oneline` shows the commit.

- [ ] **Step 5: Create GitHub repo and push**

```bash
gh repo create paurushrai/hollr --public --source . --push \
  --description "Voice + notification awareness plugin for Claude Code — hollers when your agent is done or needs you"
```

Expected: repo created, `main` pushed. Verify: `gh repo view paurushrai/hollr --json name,visibility`.

---

### Task 2: Plugin manifest, hook wiring, marketplace file, pytest scaffold

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `hooks/hooks.json`
- Create: `pyproject.toml`
- Create: `tests/conftest.py`
- Test: `tests/test_manifests.py`

**Interfaces:**
- Produces: valid plugin manifest; `hooks.json` wiring both events to `hooks/hollr_hook.py` (implemented in Task 6); pytest runnable from repo root with repo root on `sys.path`.

- [ ] **Step 1: Write the failing test**

`tests/test_manifests.py`:

```python
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def test_plugin_manifest_has_required_fields():
    manifest = _load(".claude-plugin/plugin.json")
    assert manifest["name"] == "hollr"
    assert manifest["version"] == "0.1.0"
    assert manifest["description"]
    assert manifest["author"]["name"] == "Paurush Rai"


def test_hooks_json_wires_stop_and_notification():
    hooks = _load("hooks/hooks.json")["hooks"]
    for event in ("Stop", "Notification"):
        entries = hooks[event]
        command = entries[0]["hooks"][0]["command"]
        assert "${CLAUDE_PLUGIN_ROOT}/hooks/hollr_hook.py" in command
        assert command.startswith("python3 ")


def test_marketplace_lists_hollr():
    market = _load(".claude-plugin/marketplace.json")
    names = [p["name"] for p in market["plugins"]]
    assert "hollr" in names
```

`tests/conftest.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_manifests.py -v`
Expected: FAIL — `FileNotFoundError` for `.claude-plugin/plugin.json`.

(If pytest missing: `python3 -m pip install --user pytest pytest-cov`.)

- [ ] **Step 3: Create manifests + pyproject**

`.claude-plugin/plugin.json`:

```json
{
  "name": "hollr",
  "version": "0.1.0",
  "description": "Voice + notification awareness for Claude Code: hollers when the agent is done or needs your input. Local-only, configurable via /hollr setup.",
  "author": { "name": "Paurush Rai", "email": "paurushrai99@gmail.com" },
  "homepage": "https://github.com/paurushrai/hollr",
  "license": "MIT",
  "keywords": ["notifications", "voice", "tts", "awareness", "hooks"]
}
```

`.claude-plugin/marketplace.json` (makes `/plugin marketplace add paurushrai/hollr` work):

```json
{
  "name": "hollr-marketplace",
  "owner": { "name": "Paurush Rai" },
  "plugins": [
    {
      "name": "hollr",
      "source": "./",
      "description": "Voice + notification awareness for Claude Code: hollers when the agent is done or needs your input."
    }
  ]
}
```

`hooks/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/hollr_hook.py"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/hollr_hook.py"
          }
        ]
      }
    ]
  }
}
```

`pyproject.toml`:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.coverage.run]
source = ["lib", "hooks"]
omit = ["tests/*"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_manifests.py -v`
Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/ hooks/hooks.json pyproject.toml tests/
git commit -m "feat: plugin manifest, hook wiring, marketplace entry, test scaffold"
```

---

### Task 3: lib/config.py — defaults, merge, mute, quiet hours

**Files:**
- Create: `lib/__init__.py` (empty)
- Create: `lib/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces (Task 6 consumes exactly these):
  - `DEFAULTS: dict` — the schema v1 defaults (Global Constraints block)
  - `encode_cwd(cwd: str) -> str` — every non-alphanumeric char → `-`
  - `project_config_dir(cwd: str) -> pathlib.Path` — `~/.claude/projects/<encoded>`
  - `global_config_path() -> pathlib.Path` — `~/.claude/hollr/config.json`
  - `global_config_exists() -> bool`
  - `is_configured(cwd: str) -> bool` — global config OR this project's `hollr.json` exists (a project-scope-only setup counts as configured)
  - `hint_marker_path() -> pathlib.Path` — `~/.claude/hollr/hint-shown` (once-only setup hint marker, used by Task 6)
  - `load_config(cwd: str) -> dict` — DEFAULTS ← global ← project; top-level merge, with the known nested dicts (`events`, `voice`, `notify`, `readaloud`) merged one level deep so a partial override (e.g. only `events.done`) preserves the other defaults; malformed/missing files contribute nothing (never raise)
  - `is_muted(cwd: str) -> bool` — `hollr-muted` flag file exists
  - `in_quiet_hours(quiet_hours: str | None, now: datetime.datetime) -> bool` — `"HH:MM-HH:MM"`, wraps midnight; malformed → False

- [ ] **Step 1: Write the failing tests**

`tests/test_config.py`:

```python
import datetime
import json

from lib import config


def test_encode_cwd_replaces_non_alnum():
    assert config.encode_cwd("/Users/me/my.app") == "-Users-me-my-app"


def test_load_config_returns_defaults_when_no_files(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    cfg = config.load_config("/some/project")
    assert cfg["events"]["done"]["mode"] == "announce"
    assert cfg["voice"]["name"] == "Samantha"
    assert cfg["quiet_hours"] is None


def test_load_config_merges_global_then_project(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    (tmp_path / "hollr").mkdir(parents=True)
    (tmp_path / "hollr" / "config.json").write_text(
        json.dumps({"quiet_hours": "22:00-08:00", "voice": {"engine": "system", "name": "Alex", "rate_wpm": 200}})
    )
    proj = tmp_path / "projects" / config.encode_cwd("/some/project")
    proj.mkdir(parents=True)
    (proj / "hollr.json").write_text(json.dumps({"quiet_hours": None}))
    cfg = config.load_config("/some/project")
    assert cfg["voice"]["name"] == "Alex"          # from global
    assert cfg["quiet_hours"] is None               # project overrides global
    assert cfg["events"]["done"]["mode"] == "announce"  # default survives


def test_load_config_ignores_malformed_files(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    (tmp_path / "hollr").mkdir(parents=True)
    (tmp_path / "hollr" / "config.json").write_text("{not json")
    cfg = config.load_config("/some/project")
    assert cfg == config.DEFAULTS


def test_global_config_exists(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    assert config.global_config_exists() is False
    (tmp_path / "hollr").mkdir(parents=True)
    (tmp_path / "hollr" / "config.json").write_text("{}")
    assert config.global_config_exists() is True


def test_is_configured_by_project_override_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    assert config.is_configured("/p") is False
    proj = tmp_path / "projects" / config.encode_cwd("/p")
    proj.mkdir(parents=True)
    (proj / "hollr.json").write_text("{}")
    assert config.is_configured("/p") is True   # project-scope setup counts


def test_load_config_partial_nested_preserves_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    (tmp_path / "hollr").mkdir(parents=True)
    (tmp_path / "hollr" / "config.json").write_text(
        json.dumps({"events": {"done": {"mode": "notify"}}, "voice": {"name": "Alex"}})
    )
    cfg = config.load_config("/p")
    assert cfg["events"]["done"]["mode"] == "notify"
    assert cfg["events"]["needs_input"]["mode"] == "announce"  # default survives
    assert cfg["voice"]["rate_wpm"] == 190                     # default survives


def test_is_muted_flag_file(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    assert config.is_muted("/p") is False
    proj = tmp_path / "projects" / config.encode_cwd("/p")
    proj.mkdir(parents=True)
    (proj / "hollr-muted").touch()
    assert config.is_muted("/p") is True


def _dt(hhmm: str) -> datetime.datetime:
    h, m = hhmm.split(":")
    return datetime.datetime(2026, 7, 11, int(h), int(m))


def test_quiet_hours_same_day_window():
    assert config.in_quiet_hours("09:00-17:00", _dt("12:00")) is True
    assert config.in_quiet_hours("09:00-17:00", _dt("18:00")) is False


def test_quiet_hours_wraps_midnight():
    assert config.in_quiet_hours("22:00-08:00", _dt("23:30")) is True
    assert config.in_quiet_hours("22:00-08:00", _dt("07:59")) is True
    assert config.in_quiet_hours("22:00-08:00", _dt("12:00")) is False


def test_quiet_hours_none_or_malformed_is_false():
    assert config.in_quiet_hours(None, _dt("12:00")) is False
    assert config.in_quiet_hours("garbage", _dt("12:00")) is False
    assert config.in_quiet_hours("25:00-99:99", _dt("12:00")) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'lib'` (or missing attrs).

- [ ] **Step 3: Implement lib/config.py**

`lib/__init__.py`: empty file.

`lib/config.py`:

```python
"""hollr configuration: defaults, global + per-project merge, mute, quiet hours.

All loads are defensive — malformed or missing files contribute nothing and
never raise, because this runs inside a Claude Code hook that must not fail.
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path

CLAUDE_HOME = Path.home() / ".claude"

DEFAULTS: dict = {
    "version": 1,
    "events": {
        "done": {"mode": "announce"},
        "needs_input": {"mode": "announce"},
    },
    "voice": {"engine": "system", "name": "Samantha", "rate_wpm": 190},
    "notify": {"desktop": True},
    "readaloud": {"max_chars": 1200, "strip_code": True},
    "quiet_hours": None,
}

_NON_ALNUM = re.compile(r"[^A-Za-z0-9]")
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def encode_cwd(cwd: str) -> str:
    """Match Claude Code's project-dir encoding: non-alphanumerics become '-'."""
    return _NON_ALNUM.sub("-", cwd)


def project_config_dir(cwd: str) -> Path:
    return CLAUDE_HOME / "projects" / encode_cwd(cwd)


def global_config_path() -> Path:
    return CLAUDE_HOME / "hollr" / "config.json"


def global_config_exists() -> bool:
    return global_config_path().is_file()


def is_configured(cwd: str) -> bool:
    """Setup has run if the global config OR this project's override exists."""
    return global_config_exists() or (project_config_dir(cwd) / "hollr.json").is_file()


def hint_marker_path() -> Path:
    """Marker recording that the one-time '/hollr setup' hint was shown."""
    return CLAUDE_HOME / "hollr" / "hint-shown"


def _read_json(path: Path) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


_NESTED_KEYS = ("events", "voice", "notify", "readaloud")


def _merge(base: dict, override: dict) -> dict:
    """Top-level merge; known nested dicts merge one level deep so partial
    overrides (e.g. only events.done) keep the remaining defaults."""
    merged = dict(base)
    for key, value in override.items():
        if key in _NESTED_KEYS and isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def load_config(cwd: str) -> dict:
    """DEFAULTS <- global <- project."""
    merged = _merge(DEFAULTS, _read_json(global_config_path()))
    return _merge(merged, _read_json(project_config_dir(cwd) / "hollr.json"))


def is_muted(cwd: str) -> bool:
    return (project_config_dir(cwd) / "hollr-muted").exists()


def _minutes(part: str) -> int | None:
    match = _HHMM.match(part)
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def in_quiet_hours(quiet_hours: str | None, now: datetime.datetime) -> bool:
    """True when `now` falls in "HH:MM-HH:MM"; window may wrap midnight."""
    if not quiet_hours or "-" not in quiet_hours:
        return False
    start_raw, _, end_raw = quiet_hours.partition("-")
    start, end = _minutes(start_raw), _minutes(end_raw)
    if start is None or end is None:
        return False
    current = now.hour * 60 + now.minute
    if start <= end:
        return start <= current < end
    return current >= start or current < end
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_config.py -v`
Expected: 11 PASSED.

- [ ] **Step 5: Commit**

```bash
git add lib/ tests/test_config.py
git commit -m "feat(config): defaults, nested-aware merge, mute flag, quiet hours"
```

---

### Task 4: lib/transcript.py — last assistant message + speech text prep

**Files:**
- Create: `lib/transcript.py`
- Test: `tests/test_transcript.py`
- Create: `tests/fixtures/transcript_sample.jsonl`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 6 consumes exactly these):
  - `last_assistant_message(path: str | None) -> str | None` — last assistant text from a Claude Code JSONL transcript; reads at most the final `MAX_TRANSCRIPT_BYTES` (2_000_000); missing/unreadable/no-match → None
  - `prepare_speech_text(text: str, max_chars: int = 1200, strip_code: bool = True) -> str` — code blocks → " code block omitted. ", backticks removed, whitespace collapsed, capped at max_chars

- [ ] **Step 1: Write the failing tests**

`tests/fixtures/transcript_sample.jsonl` (exact content, 4 lines):

```jsonl
{"type":"user","message":{"content":[{"type":"text","text":"do the thing"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it."}]}}
{"type":"user","message":{"content":[{"type":"text","text":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"All done."},{"type":"text","text":"Tests pass."}]}}
```

`tests/test_transcript.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_transcript.py -v`
Expected: FAIL — `ModuleNotFoundError` / `AttributeError` on `lib.transcript`.

- [ ] **Step 3: Implement lib/transcript.py**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_transcript.py -v`
Expected: 9 PASSED.

- [ ] **Step 5: Commit**

```bash
git add lib/transcript.py tests/test_transcript.py tests/fixtures/
git commit -m "feat(transcript): last assistant message extraction + speech text prep"
```

---

### Task 5: lib/speech.py — detached say + osascript

**Files:**
- Create: `lib/speech.py`
- Test: `tests/test_speech.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 6 consumes exactly these):
  - `speak(text: str, voice: str = "Samantha", rate_wpm: int = 190) -> None` — detached `say -v <voice> -r <wpm> -- <text>`; empty text → no-op
  - `notify(title: str, body: str) -> None` — detached `osascript -e 'display notification ...'`
  - `MAX_SPEECH_CHARS = 2000`
- Note: v1 hardcodes macOS binaries per spec; the engine switch (v2/v3) lands here later.

- [ ] **Step 1: Write the failing tests**

`tests/test_speech.py`:

```python
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
    assert len(_popen_argv(mock_popen)[6]) == speech.MAX_SPEECH_CHARS


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_speech.py -v`
Expected: FAIL — no module `lib.speech`.

- [ ] **Step 3: Implement lib/speech.py**

```python
"""Detached macOS voice + notification sinks. Every call is fire-and-forget:
spawn failures are swallowed because this runs inside a Claude Code hook
that must never block or break the agent turn."""

from __future__ import annotations

import subprocess

MAX_SPEECH_CHARS = 2000
MAX_NOTIFY_BODY = 200
MAX_NOTIFY_TITLE = 60


def _spawn(argv: list[str]) -> None:
    try:
        subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass  # missing binary / spawn failure must never surface into the hook


def speak(text: str, voice: str = "Samantha", rate_wpm: int = 190) -> None:
    """Speak via macOS `say`, detached. `--` stops text becoming flags."""
    if not text:
        return
    _spawn(["say", "-v", str(voice), "-r", str(int(rate_wpm)), "--", text[:MAX_SPEECH_CHARS]])


def _applescript_safe(text: str) -> str:
    """Neutralize AppleScript string escapes: drop backslashes, quotes -> '."""
    return text.replace("\\", "").replace('"', "'")


def notify(title: str, body: str) -> None:
    """Desktop notification via osascript, detached."""
    safe_body = _applescript_safe(body)[:MAX_NOTIFY_BODY]
    safe_title = _applescript_safe(title)[:MAX_NOTIFY_TITLE]
    script = f'display notification "{safe_body}" with title "{safe_title}"'
    _spawn(["osascript", "-e", script])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_speech.py -v`
Expected: 7 PASSED.

- [ ] **Step 5: Commit**

```bash
git add lib/speech.py tests/test_speech.py
git commit -m "feat(speech): detached say + osascript sinks with input sanitization"
```

---

### Task 6: hooks/hollr_hook.py — event entrypoint

**Files:**
- Create: `hooks/hollr_hook.py`
- Test: `tests/test_hook.py`
- Create: `tests/fixtures/payload_stop.json`, `tests/fixtures/payload_notification.json`

**Interfaces:**
- Consumes: `config.load_config/is_muted/is_configured/hint_marker_path/in_quiet_hours`, `transcript.last_assistant_message/prepare_speech_text`, `speech.speak/notify` — exactly as defined in Tasks 3–5.
- Produces: executable hook script; `handle(payload: dict, now: datetime.datetime) -> int` (crash-proof unit-test seam returning the exit code: 0 normally, 1 when the one-time setup hint was printed), `main() -> None` reading stdin and exiting with `handle`'s code. Exit 1 (non-blocking, non-2) is what makes Claude Code show the stderr hint to the user; exceptions inside handling are swallowed to honor "hook failures are silent no-ops".

- [ ] **Step 1: Write the failing tests**

`tests/fixtures/payload_stop.json`:

```json
{
  "hook_event_name": "Stop",
  "cwd": "/Users/me/dev/my-app",
  "transcript_path": "/tmp/replaced-in-tests.jsonl",
  "session_id": "abc123"
}
```

`tests/fixtures/payload_notification.json`:

```json
{
  "hook_event_name": "Notification",
  "cwd": "/Users/me/dev/my-app",
  "message": "Claude needs your permission to use Bash",
  "session_id": "abc123"
}
```

`tests/test_hook.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_hook.py -v`
Expected: FAIL — no module `hooks.hollr_hook`.

- [ ] **Step 3: Implement hooks/hollr_hook.py**

Also create empty `hooks/__init__.py` (makes `from hooks import hollr_hook` work in tests; harmless at runtime).

`hooks/hollr_hook.py`:

```python
#!/usr/bin/env python3
"""hollr hook entrypoint for Claude Code Stop + Notification events.

Reads the hook JSON payload on stdin, decides the configured mode for the
event, and fires voice / desktop notification. Every failure path is a
silent no-op: a hook must never block or break the agent turn.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import config, speech, transcript  # noqa: E402

MAX_PAYLOAD_BYTES = 1_000_000
TITLE = "hollr"

EVENT_KEYS = {"Stop": "done", "Notification": "needs_input"}
LINES = {
    "done": "Claude Code response is ready in {project}",
    "needs_input": "Claude Code needs your input in {project}",
}


def project_label(cwd: str) -> str:
    base = os.path.basename(cwd.rstrip("/\\")) or cwd
    return base.replace("-", " ").replace("_", " ")


def _readaloud_text(payload: dict, cfg: dict) -> str | None:
    raw = transcript.last_assistant_message(payload.get("transcript_path"))
    if not raw:
        return None
    opts = cfg.get("readaloud", {})
    return transcript.prepare_speech_text(
        raw,
        max_chars=int(opts.get("max_chars", 1200)),
        strip_code=bool(opts.get("strip_code", True)),
    )


def _deliver(mode: str, line: str, spoken: str, cfg: dict, quiet: bool) -> None:
    voice = cfg.get("voice", {})
    desktop = bool(cfg.get("notify", {}).get("desktop", True))
    if mode in ("announce", "readaloud") and not quiet:
        speech.speak(spoken, voice=voice.get("name", "Samantha"),
                     rate_wpm=voice.get("rate_wpm", 190))
    if mode == "notify" or ((mode in ("announce", "readaloud")) and desktop):
        speech.notify(TITLE, line)


def _hint_once() -> int:
    """First unconfigured event: print the setup hint and return exit code 1
    (non-blocking, non-2 — the code Claude Code surfaces stderr to the user
    for). A marker file makes this once-only."""
    marker = config.hint_marker_path()
    if marker.exists():
        return 0
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        return 0
    print("hollr: not configured — run /hollr setup", file=sys.stderr)
    return 1


def _handle(payload: dict, now: datetime.datetime) -> int:
    event_key = EVENT_KEYS.get(payload.get("hook_event_name", ""))
    cwd = payload.get("cwd") or ""
    if not event_key or not isinstance(cwd, str) or not cwd:
        return 0
    if not config.is_configured(cwd):
        return _hint_once()
    if config.is_muted(cwd):
        return 0
    cfg = config.load_config(cwd)
    events = cfg.get("events")
    mode = events.get(event_key, {}).get("mode", "silent") if isinstance(events, dict) else "silent"
    if mode not in ("announce", "readaloud", "notify"):
        return 0
    if mode == "readaloud" and event_key != "done":
        mode = "announce"  # readaloud only makes sense once the turn is over
    line = LINES[event_key].format(project=project_label(cwd))
    spoken = line
    if mode == "readaloud":
        spoken = _readaloud_text(payload, cfg) or line
    quiet = config.in_quiet_hours(cfg.get("quiet_hours"), now)
    _deliver(mode, line, spoken, cfg, quiet)
    return 0


def handle(payload: dict, now: datetime.datetime) -> int:
    """Crash-proof seam: untrusted payload/config must never break the hook."""
    try:
        return _handle(payload, now)
    except Exception:  # noqa: BLE001 — hook failures are mandated silent no-ops
        return 0


def main() -> None:
    try:
        raw = sys.stdin.read(MAX_PAYLOAD_BYTES + 1)
        if len(raw) > MAX_PAYLOAD_BYTES:
            return
        payload = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return
    if isinstance(payload, dict):
        sys.exit(handle(payload, datetime.datetime.now()))


if __name__ == "__main__":
    main()
```

Then: `chmod +x hooks/hollr_hook.py`

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_hook.py -v`
Expected: 16 PASSED.

- [ ] **Step 5: Run the full suite + coverage gate**

Run: `python3 -m pytest --cov --cov-report=term-missing`
Expected: all tests pass, total coverage ≥ 80%. If below: add tests for uncovered branches (not filler asserts).

- [ ] **Step 6: Commit**

```bash
git add hooks/ tests/test_hook.py tests/fixtures/payload_stop.json tests/fixtures/payload_notification.json
git commit -m "feat(hook): Stop + Notification entrypoint with modes, mute, quiet hours"
```

---

### Task 7: /hollr command with setup wizard

**Files:**
- Create: `commands/hollr.md`

**Interfaces:**
- Consumes: config file paths from Task 3 (`~/.claude/hollr/config.json`, `~/.claude/projects/<encoded>/hollr.json`, `hollr-muted`), schema v1 from Global Constraints.
- Produces: `/hollr`, `/hollr on|off|status|setup` available once plugin installed.

- [ ] **Step 1: Create commands/hollr.md**

````markdown
---
description: Toggle hollr announcements for this project, check status, or run the setup wizard
argument-hint: "[on|off|status|setup]"
---

# /hollr — voice + notification control

hollr announces when Claude Code finishes a turn (Stop) or needs your input
(Notification). Behavior is driven by config — until `/hollr setup` has been
run, hollr stays silent.

**Files** (encoded project dir = CWD with every non-alphanumeric char → `-`):
- Global config: `~/.claude/hollr/config.json`
- Project override: `~/.claude/projects/<ENCODED>/hollr.json`
- Project mute flag: `~/.claude/projects/<ENCODED>/hollr-muted`

Handle the argument `$ARGUMENTS`:

## No argument — toggle mute for this project

```bash
ENCODED=$(python3 -c "import re,os;print(re.sub(r'[^A-Za-z0-9]','-',os.getcwd()))")
FLAG="$HOME/.claude/projects/$ENCODED/hollr-muted"
if [ -f "$FLAG" ]; then rm "$FLAG"; echo "hollr: ON for this project"
else mkdir -p "$(dirname "$FLAG")"; touch "$FLAG"; echo "hollr: OFF for this project"; fi
```

## `on` — remove the mute flag (same ENCODED as above)

```bash
rm -f "$HOME/.claude/projects/$ENCODED/hollr-muted" && echo "hollr: ON for this project"
```

## `off` — create the mute flag

```bash
mkdir -p "$HOME/.claude/projects/$ENCODED"
touch "$HOME/.claude/projects/$ENCODED/hollr-muted" && echo "hollr: OFF for this project"
```

## `status` — report configuration

Read global config + project override + mute flag and report concisely:
- Configured: yes/no — yes if `~/.claude/hollr/config.json` OR
  `~/.claude/projects/<ENCODED>/hollr.json` exists (project-scope-only
  setup counts as configured)
- This project: ON/OFF (mute flag)
- done mode / needs_input mode / voice name + rate / quiet hours
  (effective values = defaults ← global ← project override)

## `setup` — interactive wizard

Ask the user these questions ONE AT A TIME (use the AskUserQuestion tool
when available). Show current values as defaults if config already exists.

1. **Which moments should hollr announce?** (multi-select)
   - Response ready (done) / Needs your input / both
2. **When a response is ready:**
   - Short announcement (voice line + notification)
   - Read the full response aloud
   - Desktop notification only
   - Nothing (silent)
3. **When Claude needs your input:**
   - Short announcement / Desktop notification only / Nothing
4. **Voice engine:**
   - System voice (macOS built-in, fully local)
   - Neural voice — reply: "Neural voices are coming in v3; using system
     voice for now." and write `"engine": "system"`.
5. **Voice + speaking rate:** offer Samantha (default), Alex, Daniel,
   Karen, Moira; rate 150–220 wpm (default 190).
6. **Read-aloud limits** (only if they chose read-aloud): cap length
   (default 1200 chars) and strip code blocks (default yes).
7. **Quiet hours:** none (default) or a range like `22:00-08:00` — voice is
   suppressed in that window, notifications still show.
8. **Scope:** write to global config (default) or this project's override.

Then write the answers as JSON matching this exact schema (fill defaults
for anything not asked):

```json
{
  "version": 1,
  "events": {
    "done":        { "mode": "announce" },
    "needs_input": { "mode": "announce" }
  },
  "voice": { "engine": "system", "name": "Samantha", "rate_wpm": 190 },
  "notify": { "desktop": true },
  "readaloud": { "max_chars": 1200, "strip_code": true },
  "quiet_hours": null
}
```

Valid modes — done: `announce` | `readaloud` | `notify` | `silent`;
needs_input: `announce` | `notify` | `silent`.
Mapping: "both voice+notification" → `announce` with `notify.desktop: true`;
"notification only" → `notify`; "nothing" → `silent`.

Write to `~/.claude/hollr/config.json` (global) or
`~/.claude/projects/<ENCODED>/hollr.json` (project scope), creating parent
dirs. Confirm with a one-line summary and mention `/hollr off` for muting
per project. Config takes effect on the next event — no restart needed.
````

- [ ] **Step 2: Verify the command file parses (frontmatter + fence sanity)**

Run: `python3 -c "
import re
text = open('commands/hollr.md', encoding='utf-8').read()
assert text.startswith('---'), 'missing frontmatter'
assert 'description:' in text.split('---')[1]
assert text.count('\`\`\`') % 2 == 0, 'unbalanced code fences'
print('OK')"`
Expected: `OK`

- [ ] **Step 3: Run full test suite (no regressions)**

Run: `python3 -m pytest -q`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add commands/
git commit -m "feat(command): /hollr toggle, status, and setup wizard"
```

---

### Task 8: Supersede legacy announce hook (preserve as reference)

**Files:**
- Create: `docs/reference/legacy-announce-hook.json`
- Modify: `~/.claude/settings.json` (user-global — OUTSIDE the repo)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: exactly one active announcement source on this machine (the plugin); legacy block preserved with restore instructions.

⚠️ This task edits the user's global `~/.claude/settings.json`. Show the exact before/after diff and get explicit confirmation before writing. User pre-approved the supersede in the spec, but confirm at execution time anyway.

- [ ] **Step 1: Read current global settings and extract the legacy Stop hook**

Run: `python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.claude' / 'settings.json'
print(json.dumps(json.loads(p.read_text()).get('hooks', {}).get('Stop', []), indent=2))"`
Expected: array containing the `python3 ~/.claude/tools/announce-done.py` command entry.

- [ ] **Step 2: Write the preservation file**

`docs/reference/legacy-announce-hook.json` — copy the EXACT extracted block into `removed_stop_hooks` (the value below is from the Step 1 output; verify it matches before writing):

```json
{
  "_comment": "Legacy turn-completion announcement, superseded by the hollr plugin on 2026-07-11. This block was removed from ~/.claude/settings.json 'hooks.Stop'. To restore: paste the array below back into hooks.Stop and uninstall hollr. Related legacy files kept on disk, unreferenced: ~/.claude/tools/announce-done.py, cc-speak.py, claude-speak.py, read-last-response.py, and the /speak + /readaloud skills.",
  "removed_stop_hooks": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "python3 ~/.claude/tools/announce-done.py"
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Remove the legacy Stop entry from ~/.claude/settings.json (after user confirms)**

Show the user the diff (the Stop array entry that will be removed), then:

```python
# run as: python3 <this snippet>  (or equivalent careful edit)
import json, pathlib
path = pathlib.Path.home() / ".claude" / "settings.json"
settings = json.loads(path.read_text())
stop = settings.get("hooks", {}).get("Stop", [])
kept = [entry for entry in stop
        if not any("announce-done.py" in h.get("command", "")
                   for h in entry.get("hooks", []))]
hooks = settings.setdefault("hooks", {})
if kept:
    hooks["Stop"] = kept
else:
    hooks.pop("Stop", None)
path.write_text(json.dumps(settings, indent=2) + "\n")
print("removed", len(stop) - len(kept), "legacy Stop entr(y/ies)")
```

Expected: `removed 1 legacy Stop entr(y/ies)`. Other hooks (e.g. PreToolUse `rtk`) untouched.

- [ ] **Step 4: Verify no legacy announcement remains**

Run: `python3 -c "
import json, pathlib
s = json.loads((pathlib.Path.home() / '.claude' / 'settings.json').read_text())
import sys
blob = json.dumps(s)
sys.exit(1 if 'announce-done' in blob else print('clean') or 0)"`
Expected: `clean`

- [ ] **Step 5: Commit (repo file only — settings.json is not in the repo)**

```bash
git add docs/reference/
git commit -m "docs(reference): preserve superseded legacy announce hook with restore steps"
```

---

### Task 9: README, install verification, final gates

**Files:**
- Create: `README.md` (repo root — the plugin's README; earshot product README lives in `docs/product/`)

**Interfaces:**
- Consumes: everything prior.
- Produces: shippable v0.1.0 — installable plugin, documented, all gates green, pushed.

- [ ] **Step 1: Write README.md**

````markdown
# hollr

**Hollers when your Claude Code agent is done or needs you.**

hollr is a local-only Claude Code plugin that announces the two agent
moments that matter — the turn finished, or the agent is blocked waiting on
your input — via macOS voice, a full read-aloud of the last response,
and/or a desktop notification. Nothing happens until you configure it:
run `/hollr setup` after installing.

## Install

```
/plugin marketplace add paurushrai/hollr
/plugin install hollr@hollr-marketplace
```

Then in any session:

```
/hollr setup     # first-run wizard — choose what you hear, and when
```

## What you can configure

| Moment | Options |
|---|---|
| Response ready (Stop) | short announcement · read full response aloud · notification only · silent |
| Needs your input (Notification) | short announcement · notification only · silent |

Plus: voice + speaking rate, read-aloud length cap + code stripping,
quiet hours (voice suppressed, notifications allowed), global or
per-project scope.

Read-aloud fires on the Stop hook — the turn is already complete, so the
response is read as the final action with nothing else running.

## Commands

```
/hollr           # toggle this project on/off
/hollr on|off    # explicit toggle
/hollr status    # current config + mute state
/hollr setup     # (re)run the wizard
```

## Privacy

Fully local. macOS `say` + `osascript` only — no network, no telemetry,
nothing leaves your machine. Read-aloud reads the local transcript file.

## Requirements

- macOS (v1). Linux + Windows voice: v2 roadmap.
- Claude Code with plugin support; Python 3.9+ (ships with macOS dev tools).

## Development

```
python3 -m pytest --cov     # tests + coverage (gate: ≥ 80%)
```

Design docs: `docs/superpowers/specs/`.

## License

MIT
````

- [ ] **Step 2: Full suite + coverage gate**

Run: `python3 -m pytest --cov --cov-report=term-missing -q`
Expected: all tests pass, coverage ≥ 80%. Fix any shortfall with real branch tests before proceeding.

- [ ] **Step 3: Install the plugin locally and verify hooks fire**

```
/plugin marketplace add /Users/paurushrai/Developer/personal/hollr
/plugin install hollr@hollr-marketplace
```

Then synthetic end-to-end check (real `say` + notification — audible/visible):

```bash
mkdir -p ~/.claude/hollr
[ -f ~/.claude/hollr/config.json ] || echo '{"version":1}' > ~/.claude/hollr/config.json
echo '{"hook_event_name":"Stop","cwd":"'"$PWD"'"}' | python3 hooks/hollr_hook.py
```

Expected: hear "Claude Code response is ready in hollr" + see a desktop notification. (Uses schema defaults merged over the minimal config.)

- [ ] **Step 4: Verify linear history**

Run: `git log --oneline --graph`
Expected: single straight line, no merge commits.

- [ ] **Step 5: Commit + push**

```bash
git add README.md
git commit -m "docs: plugin README with install, config, and privacy notes"
git push origin main
```

Expected: `main` on GitHub matches local; repo installable via `/plugin marketplace add paurushrai/hollr`.

---

## Post-plan notes

- **MIT license file:** `plugin.json` declares MIT — add a `LICENSE` file in Task 9 Step 5 if publishing publicly is imminent (one `curl`-free copy of the MIT text with "2026 Paurush Rai").
- **v2/v3 are roadmap only** — no Linux/Windows/neural code in this plan, per spec §9.
- **`/hollr setup` is exercised manually** (it's a command file interpreted by Claude, not testable in pytest).
