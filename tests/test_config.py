import datetime
import json

from lib import config


def test_encode_cwd_replaces_non_alnum():
    assert config.encode_cwd("/Users/me/my.app") == "-Users-me-my-app"


def test_load_config_returns_defaults_when_no_files(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CLAUDE_HOME", tmp_path)
    cfg = config.load_config("/some/project")
    assert cfg["events"]["done"]["mode"] == "announce"
    assert cfg["voice"]["name"] is None
    assert cfg["quiet_hours"] is None
    assert cfg["notify"]["desktop"] is True
    assert cfg["notify"]["sound"] is None


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
