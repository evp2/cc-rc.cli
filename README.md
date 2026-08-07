# claude-remote-control connector

Drive a headless [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
coding session from your phone. The connector runs locally next to a real project
directory, picks up instructions from the relay, executes them via the Claude
Agent SDK, and streams output back to your phone.

## Prerequisites

**1. Node.js 22+**

```bash
node --version   # must be >= 22
```

**2. Claude CLI installed and authenticated**

The Agent SDK shell-spawns the `claude` binary — it must be on your `PATH` and
logged in before you start the connector.

```bash
# Install
npm install -g @anthropic-ai/claude-code

# Authenticate (choose one):
claude login                  # claude.ai subscription (browser OAuth)
claude setup-token            # API key (paste your key when prompted)
```

For **Bedrock**, skip `claude login` and configure AWS credentials instead
(see [Bedrock provider](#bedrock) below).

**3. A running relay**

The connector needs a `relayBaseUrl` and `createSecret` from a deployed
`claude-remote-control` relay stack. See the relay's README for deploy
instructions.

## Install

```bash
npm install
npm run build         # compiles src/ -> dist/index.js
```

Or install globally so `crc` is on your PATH:

```bash
npm install -g .
```

## Configure

```bash
cp connector.config.example.json connector.config.json
# Edit: createSecret, and optionally projectDir (defaults to cwd)
```

### Anthropic provider (claude.ai subscription or API key)

```json
{
  "relayBaseUrl": "https://YOUR_RELAY.execute-api.us-east-1.amazonaws.com/test",
  "createSecret": "YOUR_CREATE_SECRET",
  "projectDir": "",
  "provider": {
    "type": "anthropic"
  }
}
```

Uses whatever login `claude login` or `claude setup-token` stored. To use a
specific API key from an environment variable instead:

```json
"provider": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
```

### Bedrock provider <a name="bedrock"></a>

```json
"provider": {
  "type": "bedrock",
  "region": "us-east-1",
  "model": "arn:aws:bedrock:us-east-1:YOUR_ACCOUNT_ID:application-inference-profile/PROFILE_ID"
}
```

Both `region` and `model` are optional. Omitted (or empty), each falls back to
the ambient environment — `AWS_REGION`/`AWS_DEFAULT_REGION` and
`ANTHROPIC_MODEL` respectively — so a shell already set up for Bedrock works
with nothing but:

```json
"provider": { "type": "bedrock" }
```

A missing model falls through to the SDK's own default. A missing region has no
default, so the connector warns at startup if it can't resolve one from the
environment.

AWS credentials are resolved from the normal SDK chain (`AWS_PROFILE`,
environment variables, SSO, instance profile, or `AWS_BEARER_TOKEN_BEDROCK`).
The connector never manages credentials itself — configure them before starting:

```bash
aws configure           # static keys
# or
aws sso login           # SSO / IAM Identity Center
```

## Run

```bash
crc start            # background (recommended)
crc status           # is it running? is the session alive?
crc qr               # re-print the pairing URL and QR code
crc stop             # stop it, leaving the session resumable
crc stop --end       # stop it and end the session (destroys the conversation)

crc run              # foreground, Ctrl-C to stop
```

Every subcommand takes `--config <path>` (default `./connector.config.json`).
Without a subcommand, `crc` runs in the foreground.

`crc start` detaches and returns, printing the phone URL and a scannable QR
code. Logs go to `~/.claude-remote-control/<key>.log`.

### Restarting does not cost you a re-pair

The connector records its session in `~/.claude-remote-control/<key>.json`
(mode 0600, keyed by project directory) and **resumes** it on the next start.
Stop it for the night, start it in the morning, and the phone reconnects on its
own with its transcript intact.

A new session — and therefore a QR scan on the phone, and a fresh Claude
conversation — is only needed when the old one has genuinely ended. `crc status`
tells you which situation you are in.

If the connector dies mid-turn, that turn is **not** re-run on restart. It is
reported to the phone as interrupted, because replaying a half-applied change
can compound it — a turn that died halfway through a refactor has already
edited some files, and running it again against that half-changed tree risks
making things worse with nobody watching. Re-send it if you still want it.

### The phone blocks while the connector is down

The composer disables itself when the connector has been unreachable for more
than a minute, so nothing can start on a machine that is asleep or gone. Closing
your laptop makes the phone read-only until you start the connector again — this
is deliberate: a turn should only ever begin while your machine is demonstrably
reachable and you're there to see it start, rather than an agent with write
access to a real checkout starting work hours later on a machine you're not
sitting at.

Nothing restarts the connector for you: after a reboot or a crash it stays down
until you run `crc start`.

## Permissions

The connector always runs with permissions bypassed, and this cannot be
configured. A permission prompt would have nobody to answer it — the phone
client has no approval round-trip — so a prompted turn would hang until the
session aged out, with no way to intervene. A connector that can silently
deadlock is worse than one whose exposure is explicit and bounded elsewhere,
so there is no safe stricter mode for a headless session.

**Point it only at checkouts you are willing to let an agent modify without
being asked.** A `permissionMode` left in an existing config is ignored, and the
connector warns about it at startup.

## How it works

1. Registers a session with the relay (`POST /sessions`), which returns a
   session ID and bearer secret — both are embedded in the phone URL.
2. Polls `GET /sessions/{id}/commands` for new instructions from the phone,
   processing them strictly one at a time.
3. Each instruction runs one `query()` call against the Claude Agent SDK
   (`resume`d from the previous call's session ID after the first turn), so
   the conversation keeps full context across turns.
4. Streamed SDK messages are mapped to a compact JSON event schema and
   batch-flushed to `POST /sessions/{id}/events` every ~750 ms for the phone
   to poll and render.
5. A turn that committed code reports its line counts to
   `POST /sessions/{id}/contributions`, attributed to `origin`. Measured by
   diffing the commit the turn started on against the one it ended on, and
   skipped entirely when the branch moved sideways or the directory is not a
   git repository. Turns that commit nothing send nothing.
