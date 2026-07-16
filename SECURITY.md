# Security Policy

## Supported versions

kelbrin is pre-1.0. Security fixes are applied to the latest published release on
npm (`kelbrin`). Please upgrade to the latest version before reporting.

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/paurushrai/kelbrin/security).
2. Click **Report a vulnerability**.
3. Include a description, reproduction steps, and the affected version.

You'll get an acknowledgement within a few days. Once a fix is ready, a patched
release is published and the advisory is disclosed with credit (unless you
prefer to remain anonymous).

## Scope notes

kelbrin is local-first. The only component that sends data off your machine is the
webhook sink, and its payload is metadata only (six fields — no working
directory, no code, no agent response). Config files that hold auth headers are
written with `0600` permissions. Reports about data leaving the machine through
any other path are especially in scope.
