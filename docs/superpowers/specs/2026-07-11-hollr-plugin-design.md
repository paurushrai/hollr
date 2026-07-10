# hollr — Claude Code Plugin Design

> Date: 2026-07-11
> Status: design approved, pre-implementation
> Origin: packages the "response ready" turn-completion announcement
> (`~/.claude/tools/announce-done.py`) as a distributable, configurable
> Claude Code plugin.

---

## 1. Goal & non-goals

**Goal:** a self-contained Claude Code plugin that announces the agent
moments that matter — **done** and **blocked-on-you (needs-input)** — the
way *the user chose at install time*, not by silent default. Output
channels: local macOS voice (`say`), full read-aloud of the last
response, and/or desktop notification. Installable via the
plugin/marketplace flow; configured by a `/hollr setup` wizard; toggleable
per project with `/hollr`.

**Non-goals (v1):**

- No Linux / Windows voice (roadmapped v2).
- No neural / cloud voice engine built (v3). The wizard *offers* it but
  falls back to system voice with a "coming soon" note.
- No phone push, rules engine, or session digest — that is the Earshot
  product, not this plugin. `hollr` is a standalone plugin.
- No coupling to existing `announce-done.py` / `cc-speak.py` / readaloud
  scripts. The plugin **supersedes** them (see §2).

**Success = configured & isolated:** a fresh Claude Code session with
only `hollr` installed does nothing until `/hollr setup` runs; after setup
it behaves exactly as configured, on done and on needs-input, with no
reference to any pre-existing config or script.

## 2. Relationship to existing setup (supersede + preserve)

Today a **global user-level** `Stop` hook in `~/.claude/settings.json`
runs `announce-done.py`. Installing `hollr` alongside it would
double-announce.

Decision: **`hollr` supersedes.** At install:

- The active `Stop` hook entry running `announce-done.py` is **removed**
  from `~/.claude/settings.json` so it no longer fires.
- `settings.json` is strict JSON (no comments), so the removed block is
  **preserved verbatim** in `docs/reference/legacy-announce-hook.json`
  with restore instructions. Nothing in `~/.claude/tools/` is deleted —
  those scripts stay as reference/backlog, simply unreferenced.
- The `/speak` and `/readaloud` skills are left in place but marked legacy
  in the reference doc; `hollr` does not call them.

Result: one active announcement source (the plugin); old implementation
stays readable for reference. `hollr` uses its **own** config + flag files
(§5) so there is zero contract with the legacy setup.

## 3. Plugin structure

```
hollr/                          # repo root = the plugin (layout A)
  .claude-plugin/
    plugin.json                # manifest
  hooks/
    hooks.json                 # wires Stop + Notification via ${CLAUDE_PLUGIN_ROOT}
    hollr_hook.py               # single event-typed entrypoint
  lib/
    config.py                  # load/merge global + per-project config, defaults
    transcript.py              # extract last assistant message for read-aloud
    speech.py                  # engine dispatch (v1: macOS say); notify (osascript)
  commands/
    hollr.md                    # /hollr on|off|status|setup
  tests/
    test_hook.py
    test_config.py
    test_transcript.py
    fixtures/                  # Stop / Notification payloads, sample transcripts
  README.md
  docs/
    product/                   # relocated earshot README/SPEC/PLAN/LAUNCH
    reference/legacy-announce-hook.json
    superpowers/specs/         # this design + future specs
```

- `plugin.json`: `name: "hollr"`, `version: "0.1.0"`, `description`,
  `author: { name: "Paurush Rai" }`.
- Hook path in `hooks.json` uses `${CLAUDE_PLUGIN_ROOT}` to resolve
  regardless of install location.

## 4. Event → behavior (config-driven)

`hollr_hook.py` reads the hook JSON on stdin, branches on
`hook_event_name`, loads config (§5), and runs the configured **mode** for
that event.

| Event | Fires when | Config key |
|---|---|---|
| `Stop` | main agent finished its turn (terminal — no tools/process running) | `events.done` |
| `Notification` | agent needs input / permission | `events.needs_input` |

**Modes** (per event):

- `announce` — speak a short line + desktop notify (notify toggle in
  config). Done: *"Claude Code response is ready in `<project>`"*.
  Needs-input: *"Claude Code needs your input in `<project>`"*.
- `readaloud` — read the **full last assistant response** aloud. Valid
  headline feature for `done`. **Timing guarantee:** because it rides the
  `Stop` hook, the turn is already complete — nothing else is running, so
  the read is the final action, exactly as required. Reads from
  `transcript_path` in the payload; applies `readaloud.max_chars` cap and
  optional `strip_code`.
- `notify` — desktop notification only, no voice.
- `silent` — nothing.

**Cross-cutting:**

- Per-project mute: if `hollr-muted` flag exists for this project → exit
  silently, regardless of mode.
- Quiet hours: if now ∈ `quiet_hours` → suppress voice (notify still
  allowed, configurable).
- Non-blocking: parse payload, spawn `say` / `osascript` detached
  (`start_new_session=True`, output to DEVNULL), return immediately. A
  subprocess failure never blocks the agent.
- Untrusted input: payload size-capped, parsed defensively; argv arrays
  only, no shell interpolation. Malformed → silent no-op.
- No config yet: hook exits silently but prints a one-line stderr hint to
  run `/hollr setup` (shown once, not spoken).

## 5. Configuration

**Files (JSON, zero-dep):**

- Global: `~/.claude/hollr/config.json`
- Per-project override: `~/.claude/projects/<encoded-cwd>/hollr.json`
  (shallow-merged over global)
- Per-project mute flag: `~/.claude/projects/<encoded-cwd>/hollr-muted`

`<encoded-cwd>` = CWD with every non-alphanumeric char → `-` (matches
Claude Code's own project-dir encoding).

**Schema (v1):**

```jsonc
{
  "version": 1,
  "events": {
    "done":        { "mode": "announce" },   // announce | readaloud | notify | silent
    "needs_input": { "mode": "announce" }     // announce | notify | silent
  },
  "voice": {
    "engine": "system",     // system (macOS say). "neural" reserved (v3) → falls back to system in v1
    "name": "Samantha",
    "rate_wpm": 190
  },
  "notify": { "desktop": true },
  "readaloud": { "max_chars": 1200, "strip_code": true },
  "quiet_hours": null        // e.g. "22:00-08:00", or null
}
```

Unknown keys ignored; missing keys fall back to built-in defaults. Schema
versioned for forward compat.

## 6. `/hollr` command & setup wizard

`commands/hollr.md`:

```
/hollr            # toggle announcements for this project (mute flag)
/hollr on         # enable this project
/hollr off        # disable this project
/hollr status     # report mode/voice/mute for this project
/hollr setup      # interactive first-run configuration wizard
```

`/hollr setup` walks the user through, then writes config:

1. **Which moments?** done · needs-input *(multi-select)*
2. **On done:** short announcement / read full response aloud /
   notification only / voice + notification
3. **On needs-input:** short announcement / notification only / both
4. **Voice engine:** system (macOS built-in) / neural (offered; v1 falls
   back to system + "coming soon")
5. **Voice + rate:** pick from top voices; set WPM
6. **Read-aloud:** cap length? (default ~1200 chars) strip code blocks?
   (default yes)
7. **Quiet hours:** none / set range
8. **Scope:** write to global config, or per-project

Wizard is idempotent — re-running shows current values as defaults and
overwrites cleanly.

## 7. Testing (isolation only)

- Framework: **pytest** (plugin is Python; no Node runtime).
- Feed fixture `Stop` / `Notification` payloads on stdin; **mock
  `subprocess.Popen`**; assert argv to `say` / `osascript`, and that
  mute/quiet-hours/silent yield zero calls.
- `config.py`: default fallback, global+project merge, malformed config →
  defaults (no raise). `transcript.py`: extract last assistant message,
  cap, strip-code, missing/short transcript edge cases.
- Cases per unit: happy + edge + failure. Coverage ≥ 80%.
- Tests touch **only** plugin code — zero dependency on existing scripts
  or user settings.

## 8. Security & privacy

- Fully local in v1: `say` + `osascript` on-device; read-aloud reads a
  local transcript file. No network.
- No `eval`, no shell interpolation; argv arrays only.
- All external input (hook payload, transcript, config) treated as
  untrusted: parsed, validated, size-capped.
- Read-aloud reads only the last assistant message from the local
  transcript; nothing is sent anywhere.

## 9. Roadmap (spec'd, not built in v1)

- **v2 — cross-platform voice + notify:** OS-detect engine — macOS `say`,
  Linux `spd-say`/`espeak`, Windows PowerShell
  `System.Speech.Synthesis`. Notify: `notify-send` (Linux), PowerShell
  toast (Windows).
- **v3 — neural voices:** implement `voice.engine = "neural"` via edge-tts
  with the voice list from the legacy `/speak` skill. Opt-in only —
  preserves the local-only guarantee unless the user chooses it. Wizard
  already collects the choice in v1.
- Marketplace publish so `/plugin` install works from `paurushrai/hollr`.

## 10. Build & delivery constraints (workflow)

- New GitHub repo **`paurushrai/hollr`** created **before** development.
  Note: `gh` is currently authed as `paurush-rai`; must re-auth as
  `paurushrai` (or grant access) before repo creation.
- **Layout A:** this dir becomes the plugin repo root; earshot product
  docs (`README/SPEC/PLAN/LAUNCH`) relocate into `docs/product/`.
- `git init` here → incremental commits on `main`; **linear history**
  (fast-forward / rebase only, no merge commits).
- Conventional Commits; every commit builds + tests pass.
