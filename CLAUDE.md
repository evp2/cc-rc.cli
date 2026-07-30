# claude-remote-control connector — setup & verification instructions

When asked to "make sure this is installed and working", follow every step
below in order. Do not skip steps. Each step has an explicit pass/fail check.
Complete every check before reporting success.

## Step 1 — Node.js version

```bash
node --version
```

**Pass:** printed version is `v22` or higher.
**Fail:** install Node.js 22+ before continuing. Do not proceed with an older version.

**Running Node 24 in cluster:** set `NODE_USE_ENV_PROXY=1` in the environment
now, before any later step talks to the relay. Without it, cluster's proxy
setup makes those requests come back `HTTP 403`.

## Step 2 — Claude CLI installed and on PATH

```bash
which claude && claude --version
```

**Pass:** both commands succeed and print output.
**Fail:** install the Claude CLI with `npm install -g @anthropic-ai/claude-code`, then re-check.

## Step 3 — Claude CLI authenticated

Determine the provider type from `connector.config.json` (or ask the user if the
file doesn't exist yet):

- **`provider.type: "anthropic"`** — run:
  ```bash
  claude auth status
  ```
  Check that `"loggedIn": true` appears in the output.

  If not logged in, choose the right method for this machine:
  - **Desktop / machine with a browser:** `claude login` (opens browser OAuth)
  - **Headless VM (no browser):** `claude setup-token` — follow the prompts to
    paste a token from https://claude.ai/settings, **or** set
    `ANTHROPIC_API_KEY` in the environment and add
    `"apiKeyEnv": "ANTHROPIC_API_KEY"` to the `provider` block in
    `connector.config.json`.

  Re-run `claude auth status` after authenticating to confirm.

- **`provider.type: "bedrock"`** — run:
  ```bash
  aws sts get-caller-identity
  ```
  **Pass:** returns a JSON object with `Account`, `UserId`, `Arn`.
  **Fail:** ask the user to configure AWS credentials (`aws configure`, `aws sso login`,
  or set `AWS_PROFILE`) before continuing.

## Step 4 — npm install

```bash
npm install
```

**Pass:** exits 0. Ignore audit warnings.
**Fail:** show the error and stop. Do not proceed with a broken install.

## Step 5 — TypeScript typecheck

```bash
npm run typecheck
```

**Pass:** exits 0 with no output (or only informational lines).
**Fail:** show the TypeScript errors and fix them before continuing.

## Step 6 — Build

```bash
npm run build
```

**Pass:** exits 0, and `dist/index.js` exists, is executable, and starts with
`#!/usr/bin/env node`. Check with:
```bash
head -1 dist/index.js && test -x dist/index.js && echo "executable: yes"
```

**Fail:** show the build error and fix it.

## Step 7 — Config file

Check whether `connector.config.json` exists:

```bash
test -f connector.config.json && echo "exists" || echo "missing"
```

If **missing**: generate it from the example, decoding the obfuscated secret:
```bash
node -e "
const fs = require('fs');
const ex = JSON.parse(fs.readFileSync('connector.config.example.json', 'utf8'));
const config = {
  relayBaseUrl: ex.relayBaseUrl,
  createSecret: Buffer.from(ex._createSecretB64, 'base64').toString('utf8'),
  projectDir: ex.projectDir,
  provider: ex.provider,
};
fs.writeFileSync('connector.config.json', JSON.stringify(config, null, 2) + '\n');
console.log('connector.config.json written');
"
```

Then confirm or adjust:
- `projectDir` — defaults to `""` which means the connector uses whatever directory
  it is launched from. Set an absolute path here to override. **The connector
  always runs with permissions bypassed (ADR 0004), so point it only at a
  checkout the user is willing to let an agent modify without being asked.**
- `provider` — already set to `{"type":"anthropic"}`; change to the Bedrock shape if needed (see README.md)

`permissionMode` is not a field any more. If an existing config still has one,
it is ignored and the connector warns at startup; remove it.

If **exists**: validate that none of the fields still contain `REPLACE_ME` or
`/path/to/`:
```bash
grep -E "REPLACE_ME|/path/to/" connector.config.json && echo "NEEDS EDITING" || echo "ok"
```

## Step 8 — Relay reachability

Extract `relayBaseUrl` from the config and hit `GET /` — this should return the
phone HTML without any auth:

```bash
RELAY=$(node -e "const c=JSON.parse(require('fs').readFileSync('connector.config.json','utf8')); process.stdout.write(c.relayBaseUrl)")
curl -sf "${RELAY}/" -o /dev/null -w "HTTP %{http_code}\n"
```

**Pass:** `HTTP 200`.
**Fail:** the relay is unreachable from this machine. Check the URL in the config, and
verify the stack is deployed (`aws cloudformation describe-stacks --stack-name <name>`).

## Step 9 — Relay auth smoke test (create + end a session)

This verifies the `createSecret` is correct and the relay's DynamoDB tables are working,
without starting the SDK or needing a phone.

Extract config values with node (works cross-platform, no jq required):

```bash
RELAY=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).relayBaseUrl")
SECRET=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).createSecret")
PROJECT=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).projectDir")
```

Create a session and capture the full response (use `-s`, not `-sf`, so failures print the error body):

```bash
SESSION=$(curl -s -X POST "${RELAY}/sessions" \
  -H "content-type: application/json" \
  -H "X-Create-Secret: ${SECRET}" \
  -d "{\"permission_mode\":\"default\",\"provider_type\":\"anthropic\",\"project_dir\":\"${PROJECT}\"}")
echo "${SESSION}"
```

Check the response contains `session_id` (not an error):

```bash
echo "${SESSION}" | node -p "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); 'session_id: ' + d.session_id + ', phone_url: ' + d.phone_url"
```

End the session to clean up:

```bash
SESSION_ID=$(echo "${SESSION}" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).session_id")
BEARER=$(echo "${SESSION}" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).secret")

curl -s -X POST "${RELAY}/sessions/${SESSION_ID}/end" \
  -H "Authorization: Bearer ${BEARER}" \
  -w "\nHTTP %{http_code}\n"
```

**Pass:** `echo "${SESSION}"` shows a JSON object with `session_id` and `phone_url`;
the end call returns `HTTP 200`.
**Fail:**
- Response is `{"error":"missing or invalid X-Create-Secret header"}` (HTTP 401) →
  `createSecret` in the config is wrong. Ask the user to provide the correct value —
  it cannot be recovered from the CloudFormation console because the parameter is `NoEcho`.
- Connection error or non-200 from step 8 → relay is down or URL is wrong.

## Step 10 — Global install (optional but recommended)

If the user wants `crc` on their PATH:

```bash
npm install -g .
crc help 2>&1 | head -3
```

**Pass:** `crc` runs without "command not found".

## Step 11 — Start it and verify the round trip

```bash
crc start
crc status
```

**Pass:** `crc start` prints a phone URL and QR code; `crc status` then shows
`process running`, `session ... (alive)`, and a `relay sees` age under 15s.

**Fail:** read the log path `crc status` prints and check it. `crc start` also
prints the last 20 log lines when the connector fails to come up.

Confirm resume works, since it is what makes a background connector usable:

```bash
crc stop && crc start
```

**Pass:** the second `crc start` prints the **same** session id and phone URL,
and the log says `Resumed session <id>`.

Leave it running, or `crc stop` to park it — the session stays resumable either
way. Use `crc stop --end` only to deliberately discard the conversation.

---

Once running, `/connector` (`.claude/skills/connector`) is the runtime companion
to this document: it routes `crc` subcommands and diagnoses an unhealthy
connector.

---

## Summary of pass criteria

All of the following must be true before reporting success:

- [ ] Node.js >= 22
- [ ] `claude` binary on PATH
- [ ] Claude CLI authenticated (anthropic) **or** AWS credentials valid (bedrock)
- [ ] `npm install` succeeded
- [ ] `npm run typecheck` clean
- [ ] `npm run build` succeeded; `dist/index.js` is executable with shebang
- [ ] `connector.config.json` exists with no placeholder values
- [ ] `GET <relayBaseUrl>/` returns HTTP 200
- [ ] `POST /sessions` with correct createSecret returns a session JSON
- [ ] `POST /sessions/{id}/end` returns HTTP 200
- [ ] `crc start` prints a phone URL; `crc status` shows the process running and
      the session alive
- [ ] `crc stop && crc start` resumes the **same** session id

If any check fails, stop, fix it, and re-run that check before moving on.
Do not report the setup as complete until every box is checked.
