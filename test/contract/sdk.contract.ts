/**
 * Contract tests: pin the @anthropic-ai/claude-agent-sdk behaviours the
 * connector depends on but that the SDK does not document or type.
 *
 * These run against the REAL SDK -- that is the entire point. Everything else
 * in test/ swaps in a fake SDK client so it can prove the connector's own
 * plumbing offline and without spending model calls. This suite is the
 * inverse: it puts the vendor boundary itself under test, so bumping the exact
 * version pin in package.json fails here instead of on a developer's phone.
 *
 * They cost nothing to run. Both probes below stop before the model is ever
 * invoked, using the two techniques src/skills.ts already relies on.
 *
 * Not part of `npm test`, which stays offline. Run with `npm run test:contract`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PERMISSION_MODE } from "../../src/config";
import { buildProviderEnv } from "../../src/provider";
import { query } from "../../src/sdk/client";
import { probeSkills } from "../../src/skills";

const execFileAsync = promisify(execFile);

/** The repo root -- a working directory with real project-scoped skills installed. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Contract tests need real credentials. Without any they skip rather than
 * fail: a developer offline, or CI without a key, should not see a red build
 * for a contract nobody exercised.
 *
 * The SDK bundles its own platform binary (see manifest.json in the package)
 * and never touches a global `claude` install, so `ANTHROPIC_API_KEY` alone
 * is sufficient -- checked first because it is the only signal CI has. Local
 * development instead usually relies on the `claude` CLI's own stored OAuth
 * login, with no API key in the environment at all, so that is checked next.
 * Confirmed empirically: with the global `claude` binary hidden from PATH,
 * `query()` still resolves its own bundled binary and reaches `system:init`.
 */
async function credentialsAvailable(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"]);
    return JSON.parse(stdout).loggedIn === true;
  } catch {
    return false;
  }
}

const SCOPE_SUFFIX = / \((?:project|user)\)$/;

/**
 * The system:init message, read straight off the stream rather than through
 * probeSkills(), so a test can assert on fields the SDK's own types do not
 * declare. Costs nothing: init is emitted before the model is invoked, and the
 * query is aborted the moment it arrives.
 */
async function readInitMessage(cwd: string): Promise<Record<string, unknown>> {
  const abortController = new AbortController();
  const q = query({
    prompt: "(contract test probe -- do not act on this)",
    options: {
      permissionMode: PERMISSION_MODE,
      allowDangerouslySkipPermissions: true,
      cwd,
      env: buildProviderEnv({ type: "anthropic" }),
      abortController,
    },
  });
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        return message as unknown as Record<string, unknown>;
      }
    }
    throw new Error("the SDK never emitted a system:init message");
  } finally {
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }
}

test("the skills menu survives whatever the SDK now reports", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  const { skills } = await probeSkills(REPO_ROOT, buildProviderEnv({ type: "anthropic" }));

  const names = new Set(skills.map((s) => s.name));

  // Asserting the menu is merely non-empty would prove nothing: selectSkills()
  // fails OPEN, so when the scope filter stops discriminating it returns every
  // model-driven command instead of none. Verified empirically -- probing a
  // directory with no project skills still yields 15, all of them bundled.
  //
  // The discriminating signal is therefore *which* skills come back. Run from
  // the repo root the menu must carry this repo's own project-scoped skills
  // and must not carry the ones bundled with Claude Code.
  assert.ok(names.has("ask-matt"), "a project-scoped skill vanished from the phone menu");
  assert.ok(
    !names.has("dataviz"),
    "a bundled skill reached the phone menu -- the scope filter stopped discriminating",
  );

  // The scope suffix is how selectSkills() tells an installed skill from one of
  // the ~15 bundled with Claude Code, and it strips the suffix on the way out.
  // A leak here means the suffix moved and the filter silently stopped
  // discriminating.
  const leaked = skills.filter((s) => SCOPE_SUFFIX.test(s.description));
  assert.deepEqual(leaked, [], "the scope suffix leaked into the phone menu");
});

test("system:init still carries the skills[] the connector reads", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  const init = await readInitMessage(REPO_ROOT);

  // skills[] is absent from the SDK's public SDKMessage type -- test/doubles.ts
  // has to cast through `unknown` to build one. selectSkills() nonetheless
  // depends on it to tell a model-driven skill from a local command, so an
  // undeclared field disappearing is a silent break the compiler cannot catch.
  assert.ok(Array.isArray(init.skills), "system:init stopped carrying a skills[] array");
  assert.ok((init.skills as unknown[]).length > 0, "system:init reported no skills at all");

  // session_id is what a restarting connector resumes the conversation from,
  // so losing it costs every parked session on the next `crc start`.
  assert.equal(typeof init.session_id, "string", "system:init stopped carrying a session_id");
});

/** The model named in system:init, for an arbitrary env. Stops before the model is invoked. */
async function initModelFor(env: Record<string, string | undefined>): Promise<unknown> {
  const abortController = new AbortController();
  const q = query({
    prompt: "(contract test probe -- do not act on this)",
    options: { cwd: REPO_ROOT, env, abortController },
  });
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        return (message as unknown as Record<string, unknown>).model;
      }
    }
    throw new Error("the SDK never emitted a system:init message");
  } finally {
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }
}

test("options.env replaces the subprocess environment rather than merging it", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  // buildProviderEnv() starts every branch from a full copy of process.env
  // precisely because options.env is a replacement, not an overlay. If the SDK
  // started merging instead, that copy would look redundant and someone would
  // eventually drop it -- at which case ambient AWS and auth variables would
  // keep leaking into a subprocess the caller believed it had scoped.
  //
  // ANTHROPIC_MODEL is the probe because system:init reports the model it
  // resolved, so both directions are observable before the model is invoked.
  const SENTINEL = "claude-sonnet-4-5";

  // Positive control: without this, the negative case below could pass simply
  // because the SDK ignores ANTHROPIC_MODEL entirely.
  assert.equal(
    await initModelFor({ ...process.env, ANTHROPIC_MODEL: SENTINEL }),
    SENTINEL,
    "the SDK stopped honouring ANTHROPIC_MODEL from options.env",
  );

  // The contract: genuinely ambient in THIS process, omitted from options.env,
  // and therefore invisible to the subprocess. Setting it on the real
  // process.env is what makes this a test of merging rather than a restatement
  // of the positive control above.
  const restore = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = SENTINEL;
  try {
    const passed = { ...process.env };
    delete passed.ANTHROPIC_MODEL;

    assert.notEqual(
      await initModelFor(passed),
      SENTINEL,
      "options.env is now merged with the parent environment, not substituted for it",
    );
  } finally {
    if (restore === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = restore;
  }
});

/** Never yields, so supportedCommands() is guaranteed to spend nothing: the subprocess can structurally never receive a user message to act on. */
async function* neverYields() {
  await new Promise<never>(() => undefined);
}

test("supportedCommands() resolves without the message stream being consumed", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  // The connector reads the phone's command menu at startup from a query whose
  // prompt never yields, which is only safe because supportedCommands()
  // resolves off the CLI's initialize response rather than off the stream. If
  // that ever changed this call would hang forever and the connector would
  // never finish starting, so the timeout here IS the assertion.
  const abortController = new AbortController();
  const q = query({
    prompt: neverYields(),
    options: {
      permissionMode: PERMISSION_MODE,
      allowDangerouslySkipPermissions: true,
      cwd: REPO_ROOT,
      env: buildProviderEnv({ type: "anthropic" }),
      abortController,
    },
  });
  try {
    const commands = await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("supportedCommands() now needs the stream drained -- startup would hang")),
          30_000,
        ),
      ),
    ]);
    assert.ok(commands.length > 0, "supportedCommands() returned nothing");
    assert.ok(
      commands.every((c) => typeof c.name === "string" && typeof c.description === "string"),
      "a SlashCommand lost its name/description shape",
    );
  } finally {
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }
});

test("every Options field a Turn passes is still accepted, resume included", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  // A Turn is built from exactly these fields. The compiler checks they still
  // typecheck; only a real subprocess proves they are still honoured -- in
  // particular the claude_code preset, without which the model is handed a
  // minimal system prompt that never states the working directory.
  const first = await readInitMessage(REPO_ROOT);
  const sessionId = first.session_id as string;

  const abortController = new AbortController();
  const q = query({
    prompt: "(contract test probe -- do not act on this)",
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: PERMISSION_MODE,
      allowDangerouslySkipPermissions: true,
      cwd: REPO_ROOT,
      env: buildProviderEnv({ type: "anthropic" }),
      abortController,
      canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      resume: sessionId,
    },
  });
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        const init = message as unknown as Record<string, unknown>;
        assert.equal(init.cwd, REPO_ROOT, "cwd stopped reaching the subprocess");
        // Resuming must continue the same conversation, not silently start a
        // fresh one -- a silent reset is what costs a parked session its history.
        assert.equal(init.session_id, sessionId, "resume silently started a new conversation");
        return;
      }
    }
    assert.fail("the SDK never emitted a system:init message");
  } finally {
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }
});

test("canUseTool still fires for AskUserQuestion under bypassPermissions", async (t) => {
  if (!(await credentialsAvailable())) {
    t.skip("no authenticated `claude` CLI -- run `claude login` to exercise the SDK contract");
    return;
  }

  // The one test in this file that spends a real model call: nothing short of
  // provoking an actual AskUserQuestion tool_use proves the callback still
  // fires. Worth the cost -- a version where it stopped firing would silently
  // kill the "questions hold the turn open" mechanism the connector relies on,
  // with no symptom visible until a phone hangs on a question that never
  // arrives.
  //
  // This is the sharp edge the SDK itself now warns about: newer versions log
  // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED, stating canUseTool "will not be invoked"
  // under bypassPermissions. Empirically that warning is about every *other*
  // tool -- AskUserQuestion is still carved out -- but the warning's own
  // wording doesn't say so, which is exactly the kind of drift this suite
  // exists to catch before a human has to.
  let firedForQuestion = false;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 45_000);
  const q = query({
    prompt: "Call the AskUserQuestion tool right now with any trivial question. Do not call any other tool.",
    options: {
      permissionMode: PERMISSION_MODE,
      allowDangerouslySkipPermissions: true,
      cwd: REPO_ROOT,
      env: buildProviderEnv({ type: "anthropic" }),
      abortController,
      canUseTool: async (toolName, input) => {
        if (toolName === "AskUserQuestion") firedForQuestion = true;
        return { behavior: "allow", updatedInput: input };
      },
    },
  });
  try {
    for await (const message of q) {
      if (message.type === "result") break;
    }
  } finally {
    clearTimeout(timer);
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }

  assert.ok(
    firedForQuestion,
    "canUseTool no longer fires for AskUserQuestion under bypassPermissions -- " +
      "the question-holds-the-turn-open mechanism is silently dead",
  );
});
