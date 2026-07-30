---
name: connector
description: Administer the local claude-remote-control connector — check whether it is running, start or stop it, re-print the pairing QR code, and diagnose why the phone has gone dead. Use when the user asks about the connector, says their phone is stuck/offline/blocked, or wants a new QR code.
---

# Administering the connector

`crc` owns every state change. Your job is to pick the right one, and — when
something is actually broken — to work out *why* before proposing a fix.

Check how `crc` is available here before assuming a layout:

```bash
which crc
```

If it is on PATH, run the subcommands below from anywhere — some installs (the
container images under `connector/examples/`, for one) put `crc` on PATH and
have no connector checkout at all. If it is not, work from the connector
directory, where `node dist/index.js <subcommand>` stands in for `crc`:

```bash
cd connector
```

Either way `crc` needs to find `connector.config.json` — it looks in the
current directory unless you pass `--config <path>`.

## Always start here

```bash
crc status
```

It reports the two halves of health separately, because they fail
independently: the local **process**, and the **session** on the relay. Read
both lines before doing anything.

## Routing table

Match what `crc status` said, then act. Do not skip to a fix without running it.

| `crc status` shows | What it means | Do this |
| --- | --- | --- |
| process running, session alive, relay sees <15s | Healthy | Nothing. If they wanted to pair a phone, run `crc qr`. |
| process running, session alive, relay sees >60s | Process is up but not talking to the relay | Diagnose — see below. The phone has blocked its composer. |
| process not running, session alive | Stopped or crashed; session is still good | `crc start`. It resumes the same session, so **no re-pair is needed**. |
| process not running, session ended | Session aged out or was ended | `crc start` mints a new one. The phone **must re-pair** — follow with `crc qr`. |
| no state at all | Never started here | `crc start`. |

## The two things people ask for

**"I need a new QR code."** Run `crc qr`. This re-prints the pairing code for
the session that already exists, and is lossless — a phone that pairs to a
session it already had gets its entire transcript back. This is the right answer
when the phone cleared its storage or they are pairing a second device.

**"The connector restarted."** That alone is not a problem: a restart resumes
the same session and the phone reconnects on its own. Run `crc status` to
confirm the session is alive, and only reach for a new session if it is not.

## Never do this

Do not suggest ending a session to fix a problem unless the session is genuinely
gone. `crc stop --end` (or a stop-then-start after it) **destroys the
conversation** — Claude's accumulated context is discarded along with the
session, and the phone must re-pair. It is a last resort, not a reset button.
Say plainly that context will be lost, and get agreement first.

## Diagnosing an unhealthy connector

When the process is running but the relay has not heard from it, or the process
died, work through these in order and report what you find:

1. **The log.** `crc status` prints its path and tails it when the process is
   down. Read more with `tail -50 <log path>`. Most failures say exactly what
   happened.
2. **Credentials.** These expire silently in a long-running connector, and it is
   the most common cause of a connector that was fine yesterday:
   - Anthropic: `claude auth status` — look for `"loggedIn": true`. Fix with
     `claude login`.
   - Bedrock: `aws sts get-caller-identity`. An expired SSO session fails here.
     Fix with `aws sso login` (the user must run this themselves — suggest they
     type `! aws sso login`).
3. **Relay reachability.** `curl -sf <relayBaseUrl>/ -o /dev/null -w "HTTP %{http_code}\n"`
   — expect `HTTP 200`. Anything else means the relay, not the connector, is the
   problem.
4. **A wedged process.** If the process is alive but the log has been silent and
   credentials are fine, `crc stop` then `crc start` — this resumes the session,
   so it costs nothing.

Propose the fix and ask before acting on anything that stops a process or
changes credentials.

## Interpreting what the user sees on their phone

- **"connector unreachable", composer disabled** — deliberate. A turn only ever
  starts while the machine is reachable, because the connector runs with
  permissions bypassed and nothing should begin unwatched. The fix is always
  `crc start` on the machine; it cannot be fixed from the phone.
- **"connector lagging"** — late but still accepting work. Usually a long turn
  with no output yet. Not a fault.
- **"session ended", red dot** — terminal. Needs `crc start` and a re-pair.
- **An error saying the previous turn was interrupted** — expected after a crash
  mid-turn. That command is deliberately not re-run, because replaying it
  against a half-changed tree can compound the damage. The user re-sends if they
  still want it.

## Background

`docs/adr/0001` (at-most-once execution), `docs/adr/0002` (resume across
restarts), `docs/adr/0003` (nothing runs unattended) explain why these
behaviours are the way they are. `CONTEXT.md` defines *reachable* vs *ended* and
*resume* vs *re-pair* vs *rotate* — use those words precisely, they mean
different things here.
