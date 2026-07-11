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
