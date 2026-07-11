# Contributing to hollr

Thanks for helping make hollr better. This guide gets you from clone to merged PR.

## Prerequisites

- **Node ≥ 20** (CI runs on 20 and 22).
- macOS is the stable platform; Linux and Windows engines are in beta.

## Local setup

```bash
git clone https://github.com/paurushrai/hollr.git
cd hollr
npm ci
npm run build   # bundle src/index.ts -> dist/index.js (tsup)
npm test        # vitest, full suite
```

To exercise the CLI from a local build:

```bash
node dist/index.js status
node dist/index.js doctor
```

## How the code is laid out

- `src/adapters/` — one file per agent integration (detect + wire + normalize).
- `src/core/` — config, event model, and the router that turns an event into
  sink calls.
- `src/cli/` — subcommands (`init`, `emit`, `run`, `status`, `mute`, `quiet`, …).
- `src/platform/` — per-OS voice/notify/sound engines.
- `src/sinks/` — the webhook sink (the only code that touches the network).
- `tests/` — mirrors `src/`; every test is hermetic (temp `HOLLR_HOME`, injected
  clock and IO).

## Working style

- **Test-driven.** Write a failing test first, then the minimal code to pass it.
  Cover happy path, edges, and failure modes.
- **Anything reachable from a hook must never throw.** `hollr emit` and the
  router run inside an agent's hook; on any error they must degrade to exit 0 so
  they never break an agent turn.
- **Keep it hermetic.** Mock time, randomness, network, and the filesystem home
  (`HOLLR_HOME`). No test may touch the developer's real `~/.config/hollr`.
- **Coverage ≥ 80%.**

## Commits & PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary` (e.g. `feat(cli): add hollr quiet`).
- Keep each commit green (build + tests passing).
- Open a PR against `main` with **what / why / how-to-test**. CI (build + tests
  on Node 20 and 22) must be green before merge.

## Reporting bugs / requesting features

Open an issue using the templates. For security issues, do **not** open a public
issue — see [SECURITY.md](SECURITY.md).
