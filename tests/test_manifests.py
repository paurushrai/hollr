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
