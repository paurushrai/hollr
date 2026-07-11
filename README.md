# hollr

**hollr calls out the moment your CLI coding agent finishes or needs you.**

Kick off a long agent run, switch to something else, and stop babysitting the
terminal. The second your agent finishes a turn — or stalls waiting on your
input — hollr speaks up: it reads the response aloud, fires a desktop
notification, plays a sound, and/or pings your phone. You get back to it exactly
when it needs you — not a minute sooner, not ten minutes later.

- **Local-first, zero telemetry.** Voice, notifications, and sound never leave
  your machine. The only thing that ever goes off-device is a webhook you set up
  yourself — and that payload is metadata only (see [Privacy](#privacy)).
- **Works with every agent.** 8 first-class integrations — Claude Code, Codex,
  Gemini CLI, Copilot CLI, Cursor, opencode, Antigravity, Amp — plus a universal
  wrapper (`hollr run`) that adds done/error alerts to *any* command.
- **Nothing invasive in your setup.** hollr wires each agent's own hook config
  to call `hollr emit` — no SDK, no background daemon. Every change is previewed
  before it's written and is byte-reversible with `hollr uninstall`.

## Install

Requires **Node ≥ 20**.

```bash
npm i -g hollr-cli
hollr init          # interactive setup wizard: pick agents, sounds, webhooks
```

Or run it without a global install:

```bash
npx hollr-cli init
```

`hollr init` detects which agents you have, shows you the exact config diff
before writing anything, and lets you choose what you hear and when.

## Turning it on and off

At setup, hollr asks whether it should notify you **in every project** or
**only in projects you turn on**. You can change your mind per project or pause
everything for a while:

| Want | Command |
|------|---------|
| Turn hollr on for this project | `hollr on` |
| Turn it off for this project | `hollr off` |
| Quiet everywhere for a bit | `hollr quiet` · `hollr quiet 30m` |
| Turn quiet back off | `hollr quiet off` |
| See what hollr is doing and why | `hollr status` |

`hollr quiet 30m` comes back on by itself after 30 minutes; a bare `hollr quiet`
stays quiet until you run `hollr quiet off`.

## Agent support

Each integration is defined by what the agent's own hooks can actually deliver —
this table reflects the shipped adapter capabilities, not aspirations.

| Agent | done | blocked | read-aloud | slash cmd | Notes |
|---|:---:|:---:|:---:|:---:|---|
| **Claude Code** | ✅ | ✅ | ✅ | `/hollr` | Reference integration; read-aloud from the JSONL transcript. |
| **Codex** (OpenAI) | ✅ | ✅ | ✅ | — | `notify` for done + read-aloud; `hooks.json` PermissionRequest for blocked (needs one-time trust in Codex). |
| **Copilot CLI** (GitHub) | ✅ | ✅ | ✅ | — | `agentStop` + notification hooks. |
| **Gemini CLI** (Google) | ✅ | ✅ | ✅ | `/hollr` | `AfterAgent` done, `Notification` blocked. |
| **Antigravity** (agy) | ✅ | — | — | — | Announce-only: no needs-input event, opaque transcript. |
| **Cursor** (cursor-agent) | ✅ | — | — | — | Native stop-hook announce; blocked + read-aloud come via `hollr run`. |
| **opencode** (sst) | ✅ | ✅ | — | — | Plugin bridges `session.idle` (done) + `permission.asked` (blocked); read-aloud off (opaque storage). |
| **Amp** (Sourcegraph) | ✅ | — | — | — | Announce-only via Amp's built-in notifications + `hollr run`; not auto-wired. |
| **`hollr run`** (wrapper) | ✅ | — | ✅ | — | Universal fallback for *any* command: done/error on exit. Cursor stream read-aloud via `--announce-stream cursor`. |

Read-aloud speaks the agent's last response. "blocked" fires when the agent is
waiting on your input. A dash means the agent's surface doesn't expose that
signal — not that hollr chose to omit it.

**Platform status:** macOS is stable. **Linux and Windows are beta** — voice,
desktop notifications, and sound are implemented but not yet
hardware-end-to-end verified.

> Locally verified against a real install: Claude Code. The Codex, Copilot,
> Gemini, opencode, Amp, and Cursor integrations were built against their
> published hook/config docs.

## Webhooks

Get pinged on your phone or a chat channel when an agent finishes. hollr
supports four providers:

- **ntfy** — push to the ntfy app/self-hosted server.
- **pushover** — Pushover push notifications.
- **slack** — Slack incoming webhook.
- **generic** — raw JSON POST to any endpoint you control.

Configure targets in `hollr init`. Each target has a `name`, `provider`, `url`,
the `events` it fires on (`done` / `blocked`), and optional auth `headers`.
`https://` is required; plain `http://` is rejected unless you opt in with
`allowHttp`. Targets with auth headers cause the global config to be chmod'd to
`0600`.

### The payload is metadata only

The webhook sink is the *only* part of hollr that touches the network, and it
has a single serializer that emits exactly six fields — and nothing else:

```json
{
  "v": 1,
  "ts": "2026-07-11T18:32:04.512Z",
  "agent": "claude-code",
  "event": "done",
  "project": "my project",
  "summary": "hollr test"
}
```

It **never** sends your working directory, your code, or the agent's response.
`project` is only the basename of the folder (dashes/underscores turned into
spaces for speaking). `summary` is the short status line the agent supplied.
Provider bodies (ntfy title, Slack text, etc.) are derived from these same
fields — there is no other path off the machine.

Preview and test before you trust it:

```bash
hollr test --show-payload   # print the exact off-machine payload, send nothing
hollr test --webhook        # fire your configured webhook targets for real
hollr test                  # drive the local sinks (voice + desktop notify)
```

## Hotkeys — control read-aloud

Read-aloud can run long. hollr exposes `pause` / `resume` / `stop` so you can
bind them to system hotkeys:

- **macOS** — create Shortcuts in Shortcuts.app that run `hollr pause`,
  `hollr resume`, and `hollr stop`, then assign each a keyboard shortcut.
- **Linux** — bind `hollr pause` / `hollr resume` / `hollr stop` to keys in your
  desktop environment's keyboard settings (GNOME/KDE custom shortcuts).
- **Windows** — use AutoHotkey to map keys to the commands. **Windows is
  stop-only** — `hollr stop` works, but there is no pause/resume (no `SIGSTOP`
  equivalent for the speech process).

## Command reference

| Command | What it does |
|---|---|
| `hollr init` | Interactive setup wizard: detect agents, wire hooks, configure sounds/webhooks. |
| `hollr uninstall` | Reverse every change hollr made (byte-for-byte, from its ledger). |
| `hollr emit` | Internal: agents' hooks call this to report an event (`--payload-stdin` / `--payload-argv`). Never breaks a turn. |
| `hollr run -- <cmd>` | Universal wrapper: run any command and announce done/error on exit. `--announce-stream cursor` for Cursor read-aloud. |
| `hollr test` | Fire a synthetic event to verify your setup. `--show-payload` / `--webhook`. |
| `hollr status` | Explain, in plain words, whether hollr is speaking here and why — scope, this project's state, and any active quiet. |
| `hollr pause` | Pause the current read-aloud. |
| `hollr resume` | Resume a paused read-aloud. |
| `hollr stop` | Stop the current read-aloud. |
| `hollr mute [on\|off]` | Mute/unmute all hollr output for the current project (toggles if no arg). |
| `hollr on` / `hollr off` | Turn hollr on or off for the current project (aliases: `unmute` / `mute`). |
| `hollr quiet [duration\|off]` | Quiet all projects for a while (`hollr quiet 30m`) or until `hollr quiet off`. |
| `hollr doctor` | Check prerequisites (voice/notify/sound tools, detected agents) with exact fix commands. |
| `hollr --version` | Print the version (`-v`). |

hollr also honors **quiet hours** (voice suppressed on a schedule; webhooks and
notifications configurable independently).

## Privacy

hollr is local-first. Voice (`say`/equivalent), desktop notifications, and
sound all run on your machine with no telemetry and no network. The *only*
outbound traffic is webhooks you explicitly configure, and those carry the
six-field metadata payload above — never your cwd, your code, or the agent's
response. Read-aloud reads the local transcript and speaks it locally; the text
never leaves the machine.

## Development

```bash
npm test            # vitest
npm run coverage    # vitest + v8 coverage (gate: ≥ 80%)
npm run build       # bundle to dist/index.js via tsup
```

## License

MIT — see [LICENSE](LICENSE).
