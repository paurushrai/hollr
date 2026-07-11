---
description: Toggle hollr announcements for this project, check status, run the setup wizard, check prerequisites, or pause/resume/stop read-aloud
argument-hint: "[on|off|status|setup|doctor|pause|resume|stop]"
---

# /hollr — voice + notification control

hollr announces when Claude Code finishes a turn (Stop) or needs your input
(Notification). Behavior is driven by config — until `/hollr setup` has been
run, hollr stays silent.

**Files** (encoded project dir = CWD with every non-alphanumeric char → `-`):
- Global config: `~/.claude/hollr/config.json`
- Project override: `~/.claude/projects/<ENCODED>/hollr.json`
- Project mute flag: `~/.claude/projects/<ENCODED>/hollr-muted`
- Read-aloud pidfile: `~/.claude/hollr/reading.pid`

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

## `pause` — pause read-aloud in progress

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-ctl pause
```

## `resume` — resume a paused read-aloud

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-ctl resume
```

## `stop` — stop read-aloud in progress

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-ctl stop
```

Run the command, then echo its printed output verbatim (it already reports
success or "hollr: nothing is being read"). These are the same three shell
commands you'd bind to a hotkey — see **Bind a hotkey** below for controlling
read-aloud without going through Claude Code at all.

## `status` — report configuration

Read global config + project override + mute flag and report concisely:
- Configured: yes/no — yes if `~/.claude/hollr/config.json` OR
  `~/.claude/projects/<ENCODED>/hollr.json` exists (project-scope-only
  setup counts as configured)
- This project: ON/OFF (mute flag)
- done mode / needs_input mode / voice name + rate / quiet hours
  (effective values = defaults ← global ← project override)

## `doctor` — check prerequisites

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-doctor
```

Run it, then summarize the results to the user (don't just paste the raw
output): which checks passed, which required checks failed and why, and
which optional ones are missing. For each **failed** check that has a
`fix` command:
- If the fix is exactly `xcode-select --install` (macOS's own GUI
  installer — safe, no sudo, no third-party package manager), ask the
  user via AskUserQuestion whether to run it now. Only run it if they say
  yes.
- For every other fix (e.g. the Claude Code docs URL), just show the
  command/link and tell the user they can run or open it in a separate
  terminal. Never auto-run installers, `sudo`, or package managers
  yourself.

## `setup` — interactive wizard

**Step 0 — run the doctor first.** Run
`python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-doctor` exactly as in the
`doctor` section above. If all required prerequisites are present,
continue silently into Step 1. If any required prerequisite is missing,
warn the user with the specific failures and fixes, then ask (via
AskUserQuestion) whether to continue configuring anyway or stop here to
fix prerequisites first. If they choose to stop, do not proceed past this
step.

Ask the user these questions ONE AT A TIME (use the AskUserQuestion tool
when available). Show current values as defaults if config already exists.

1. **Which moments should hollr announce?** (multi-select)
   - Response ready (done) / Needs your input / both
2. **When a response is ready:**
   - Short announcement (voice line + notification)
   - Read the full response aloud (can be paused/resumed/stopped mid-speech
     via a hotkey — see **Bind a hotkey** below)
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
7. **Play an alert sound before the announcement?** default **None** (no
   sound). Offer common macOS system tones: `Glass`, `Ping`, `Funk`,
   `Submarine`, `Hero`. The sound always plays fully FIRST, then the voice
   speaks — never simultaneously — which helps the cue cut through when
   macOS Dictation or another app ducks (lowers) speech volume. Write the
   chosen name to `notify.sound`, or `null` for none.
8. **Quiet hours:** none (default) or a range like `22:00-08:00` — voice
   (and any alert sound) is suppressed in that window, notifications still
   show.
9. **Scope:** write to global config (default) or this project's override.

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
  "notify": { "desktop": true, "sound": null },
  "readaloud": { "max_chars": 1200, "strip_code": true },
  "quiet_hours": null
}
```
`voice.name: null` = use the OS's default voice (recommended); set it to an
installed voice's name only when the user opts into a specific one.
`notify.sound: null` = no alert tone (default); set to a macOS system sound
name (e.g. `"Glass"`) to play that tone first, then the voice.

Valid modes — done: `announce` | `readaloud` | `notify` | `silent`;
needs_input: `announce` | `notify` | `silent`.
Mapping: "both voice+notification" → `announce` with `notify.desktop: true`;
"notification only" → `notify`; "nothing" → `silent`.

Write to `~/.claude/hollr/config.json` (global) or
`~/.claude/projects/<ENCODED>/hollr.json` (project scope), creating parent
dirs. Confirm with a one-line summary and mention `/hollr off` for muting
per project. Config takes effect on the next event — no restart needed.

## Bind a hotkey

Read-aloud (`readaloud` mode) can be paused, resumed, or stopped mid-speech
from a **global hotkey** — no daemon, no new permissions. While speaking,
hollr tracks the `say` process's PID in `~/.claude/hollr/reading.pid`;
`bin/hollr-ctl` signals that PID (SIGSTOP / SIGCONT / SIGTERM). A macOS
global hotkey can only run a shell command, not a Claude Code slash command,
so bind it directly to this script — it works whether or not Claude Code is
the focused app:

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-ctl pause
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-ctl resume
python3 ${CLAUDE_PLUGIN_ROOT}/bin/hollr-ctl stop
```

Resolve `${CLAUDE_PLUGIN_ROOT}` to this plugin's absolute install path
before binding (macOS Shortcuts can't expand Claude Code env vars) — e.g.
`python3 /path/to/hollr/bin/hollr-ctl pause`. Ask the user to confirm the
resolved path, or read it from the plugin's installed location.

**macOS (v1, supported now):**
1. Open **Shortcuts.app** → **+** to create a new Shortcut.
2. Add the **"Run Shell Script"** action, paste the resolved `hollr-ctl`
   command above (pick pause, resume, or stop — one shortcut per action).
3. Open the new Shortcut's **Details** (`ⓘ`) and assign a keyboard shortcut.
4. Repeat for the other two actions if wanted. The hotkey now works
   globally, independent of which app has focus.

**Linux / Windows (v2, not yet speaking — this plugin is macOS-only for
voice today, but the control mechanism is identical once it lands):**
- **Linux:** bind the same `python3 .../bin/hollr-ctl <action>` command in
  your desktop environment's keyboard shortcut settings (e.g. GNOME Settings
  → Keyboard → Custom Shortcuts).
- **Windows:** use **AutoHotkey** — map a hotkey to `Run, python3 ...\bin\hollr-ctl pause` (and resume/stop).
