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
ENCODED=$(python3 -c "import re,os;print(re.sub(r'[^A-Za-z0-9]','-',os.getcwd()))")
rm -f "$HOME/.claude/projects/$ENCODED/hollr-muted" && echo "hollr: ON for this project"
```

## `off` — create the mute flag

```bash
ENCODED=$(python3 -c "import re,os;print(re.sub(r'[^A-Za-z0-9]','-',os.getcwd()))")
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
5. **Voice + speaking rate:** default (recommended) is **your operating
   system's default voice** — writes `voice.name: null`, so `say` runs with
   no `-v` flag and simply uses whatever voice is configured in macOS
   System Settings. Offer picking a specific installed voice as the
   opt-in alternative for users who want a voice other than their OS
   default: enumerate the voices actually installed on this machine and
   let the user pick one in-terminal — no leaving the session, no context
   switch. On macOS (v1) run `say -v '?'` and parse it: each line is
   `<Name>  <lang>  # <sample>` (name may contain spaces — the name is
   everything before the run of 2+ spaces before the locale). Present the
   names (optionally grouped/filtered to the user's locale prefix, e.g.
   `en`). Then ask speaking rate 150–220 wpm (default 190). Write the
   chosen name to `voice.name`; if the user sticks with the OS default,
   leave `voice.name` as `null`. For Linux/Windows (v2 engines, not yet
   speaking) the equivalent enumeration is `spd-say -L` / `espeak --voices`
   and PowerShell
   `[System.Speech.Synthesis.SpeechSynthesizer]::new().GetInstalledVoices()`
   — the wizard should detect the OS and, on non-macOS, tell the user voice
   playback lands in v2 and record their engine preference only.

   Enumerate with (macOS):
   ```bash
   say -v '?' | sed -E 's/ {2,}.*//' | sort -u
   ```
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
  "voice": { "engine": "system", "name": null, "rate_wpm": 190 },
  "notify": { "desktop": true },
  "readaloud": { "max_chars": 1200, "strip_code": true },
  "quiet_hours": null
}
```
`voice.name: null` = use the OS's default voice (recommended); set it to an
installed voice's name only when the user opts into a specific one.

Valid modes — done: `announce` | `readaloud` | `notify` | `silent`;
needs_input: `announce` | `notify` | `silent`.
Mapping: "both voice+notification" → `announce` with `notify.desktop: true`;
"notification only" → `notify`; "nothing" → `silent`.

Write to `~/.claude/hollr/config.json` (global) or
`~/.claude/projects/<ENCODED>/hollr.json` (project scope), creating parent
dirs. Confirm with a one-line summary and mention `/hollr off` for muting
per project. Config takes effect on the next event — no restart needed.
