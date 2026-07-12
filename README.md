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
  before it's written, and `hollr uninstall` surgically removes only what hollr
  added — edits you make afterward are preserved (see
  [Limitations & caveats](#limitations--caveats)).

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

### Read-aloud "speakable mode"

When you pick **read-aloud** for the `done` event during `hollr init`, hollr can
add a small, clearly-marked instruction to each supported agent's global memory
file (Claude Code `~/.claude/CLAUDE.md`, Codex `~/.codex/AGENTS.md`, Gemini
`~/.gemini/GEMINI.md`). It asks the model to keep its final message speakable and
to write code or dense detail to a temp `.md` file it opens with your chosen
markdown command instead of speaking it.

- **Only three agents** support this today — **Claude Code, Codex, Gemini** (the
  ones with a global standing-instructions file). Other agents don't offer it.
- **Opt-in** — offered only when read-aloud is your `done` mode, only for agents
  you wire.
- **Reversible** — it's a marked block; re-running `hollr init` with read-aloud
  off removes just that block and leaves the rest of your file untouched.
  `hollr uninstall` reverses everything hollr wired.
- **Best-effort, not a guarantee** — it's a prompt *nudge*. The model decides
  whether to comply; it may still speak something technical, or over-use files.
- **hollr opens the file, your editor renders it** — the model runs your
  configured open command; whether that shows a *rendered* preview or raw source
  is up to that app (VS Code needs a preview command, etc.). hollr can't force a
  rendered view.
- **Tidy, within its own directory** — temp files under
  `~/.config/hollr/readaloud/` are auto-removed after 24h. If the model ignores
  that location and writes elsewhere, hollr can't clean those up.

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
| `hollr uninstall` | Reverse every wiring hollr made — surgically removes only hollr's own entries from shared files (your later edits survive) and deletes files hollr created. |
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

## Limitations & caveats

Known boundaries, so nothing surprises you:

- **Read-aloud "speakable mode" is a nudge, not a contract.** It works by adding
  an instruction to the agent's memory file (Claude Code / Codex / Gemini only).
  The *model* chooses whether to keep responses speakable and move code to a
  file — hollr can't enforce it. It opens that file with your command, but
  rendering is your editor's job, and hollr only auto-cleans temp files kept
  under `~/.config/hollr/readaloud/` (see [above](#read-aloud-speakable-mode)).

- **`hollr uninstall` is surgical, not a time machine.** It removes hollr's *own*
  additions from each shared config file using the file's current contents, so
  edits you made after setup are preserved. Consequences:
  - **Codex `notify` is not restored.** Codex allows a single top-level `notify`
    command, so hollr's setup *replaces* any `notify` you already had. Uninstall
    removes hollr's line but cannot bring your original `notify` back — if you
    used one, re-add it by hand.
  - **Config files hollr *created* are left empty, not deleted.** If hollr had to
    create a shared file (e.g. an agent's `settings.json` that didn't exist),
    uninstall strips hollr's entries and leaves an empty `{}` rather than
    guessing the file is safe to remove. Files hollr owns outright (its slash
    command, the opencode plugin) are deleted.
  - **Retired legacy (v0.1.x) hooks stay retired.** Setup permanently migrates
    away from the old Python integration; uninstall does not resurrect it.
  - **A rare write failure is isolated.** If one adapter's file can't be written
    during uninstall (e.g. permissions), hollr skips it, reports it, and
    continues; re-run `hollr uninstall` after fixing the cause.

- **Claude Code done-alerts wait for background sub-agents.** hollr holds the
  `done` announcement while Claude Code reports in-flight delegated work
  (sub-agents, workflows, teammates) so you're not pinged mid-run — you're
  alerted once, at the real end. Long-lived `shell`/watcher and `monitor` tasks
  are ignored (they'd otherwise silence every alert). Requires **Claude Code ≥
  2.1.145**; on older versions the alert fires as before.

- **Legacy `allowHttp` configs.** http opt-in is now per webhook target. A config
  written before this change keeps its old global behavior until you re-run
  `hollr init`, which migrates it to per-target flags.

- **Codex "blocked" needs one-time trust.** Codex requires you to review and
  trust its command hook once (run `codex` and approve it) before the blocked
  alert fires.

- **Linux & Windows are beta**, and **Windows is stop-only** for read-aloud (no
  pause/resume) — see [Agent support](#agent-support) and
  [Hotkeys](#hotkeys--control-read-aloud).

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
