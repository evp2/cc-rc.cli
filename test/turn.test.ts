import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";

import { contextWarningCrossing, runTurn } from "../src/session/turn.ts";
import {
  assistantText,
  cmd,
  compactBoundary,
  init,
  makeTurnHarness,
  result,
  type TurnHarness,
} from "./doubles.ts";

const types = (h: TurnHarness) => h.ctx.eventBuffer.map((e) => e.type);

test("an ordinary Turn holds nothing at the end", async () => {
  const h = makeTurnHarness([init(), assistantText("hello"), result()]);

  await runTurn(h.ctx, cmd("say hello"));

  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.ledger.current(), undefined);
  assert.equal(h.ctx.currentTurn, undefined);
  assert.equal(h.ctx.currentQuery, undefined);
  assert.deepEqual(h.relay.reports, [true, false]);
  assert.ok(types(h).includes("assistant_text"));
  assert.ok(types(h).includes("turn_complete"));
});

test("a Steer the SDK never confirms does not leak its claim", async () => {
  // The originating bug. A Local command (`/compact`) streamed into a running
  // Turn is answered by the CLI itself: it reports a compact_boundary and a
  // result and then ends the query, never the fresh `init` that would confirm
  // the Steer. Nothing else ever released it, so the phone's brake and
  // Thinking placeholder stayed on against a session that had finished.
  let h: TurnHarness;
  h = makeTurnHarness([init(), assistantText("working"), compactBoundary(), result()], {
    onYield: async (message) => {
      if (message.type === "result") {
        await h.ledger.current()!.steer(cmd("/compact"));
      }
    },
  });

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ledger.snapshot(), undefined, "nothing is still held");
  assert.equal(h.relay.lastReport, false, "the phone is told the Turn is over");
});

test("the Turn that took an unconfirmed Steer is marked steered and skips the push", async () => {
  let h: TurnHarness;
  h = makeTurnHarness([init(), assistantText("working"), result()], {
    onYield: async (message) => {
      if (message.type === "result") await h.ledger.current()!.steer(cmd("a correction"));
    },
  });

  await runTurn(h.ctx, cmd("first"));

  const complete = h.ctx.eventBuffer.find((e) => e.type === "turn_complete");
  assert.ok(complete, "the Turn still reports its own outcome");
  assert.equal(complete.no_notify, true, "a buzz for a Turn the human cut short would be a lie");
  const status = h.ctx.eventBuffer.filter((e) => e.type === "status").map((e) => e.text);
  assert.ok(status.includes("steered"), "neutral wording, not 'interrupted'");
});

test("a confirmed Steer is promoted and both Turns settle", async () => {
  // Two inits and two results in one query -- the shape a real Steer produces.
  const steer = cmd("a correction");
  let h: TurnHarness;
  h = makeTurnHarness(
    [init(), assistantText("working"), result(), init("sdk-2"), assistantText("corrected"), result()],
    {
      onYield: async (message) => {
        if (message.type === "result" && !h.ledger.current()?.pendingSteerSeq) {
          await h.ledger.current()!.steer(steer);
        }
      },
    },
  );

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ledger.snapshot(), undefined);
  // Never flickers false between the truncated Turn and the steered one: the
  // Steer was already held when the first result settled.
  assert.deepEqual(h.relay.reports, [true, false]);
  assert.equal(h.ctx.sdkSessionId, "sdk-2", "the fresh init's session id was adopted");
  assert.equal(h.ctx.eventBuffer.filter((e) => e.type === "turn_complete").length, 2);
});

test("a Steer confirmed before the truncated sub-turn's result still releases it", async () => {
  // The interrupt ordering: the fresh `init` opens the Steer's sub-turn
  // before -- and instead of -- any `result` for the sub-turn it cut off, so
  // settleActive() never runs for the original Command. Once the Steer
  // becomes active nothing else names it, and it stays held for the life of
  // the process with the phone's brake and Thinking indicator stuck on.
  const steer = cmd("a correction");
  let steered = false;
  let h: TurnHarness;
  h = makeTurnHarness(
    [init(), assistantText("working"), init("sdk-2"), assistantText("corrected"), result()],
    {
      // Claimed while the first sub-turn is still working, so the `init`
      // below is the first thing the connector hears after it -- there is no
      // `result` for the sub-turn the Steer truncated.
      onYield: async (message) => {
        if (message.type === "assistant" && !steered) {
          steered = true;
          await h.ledger.current()!.steer(steer);
        }
      },
    },
  );

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ledger.snapshot(), undefined, "neither Command is left held");
  // Still no flicker mid-Turn: the Steer was promoted before the Command it
  // superseded was released.
  assert.deepEqual(h.relay.reports, [true, false]);
  assert.equal(h.ctx.sdkSessionId, "sdk-2");
});

test("the drain loop stops once the abort signal fires, even if the SDK generator keeps yielding after it", async () => {
  // Observed in production: a Stop mid-turn can leave the SDK's generator
  // yielding further messages against an already-torn-down transport (each
  // one failing getContextUsage with "Query closed"/"ProcessTransport is not
  // ready for writing") instead of ending cleanly. Nothing inside the drain
  // loop checked the signal, so it kept consuming those messages forever --
  // duringTurn's claim-settling finally block was never reached, leaving
  // in_flight stuck true and the phone's composer stuck on Stop.
  const h = makeTurnHarness(
    [init(), assistantText("before"), result(), assistantText("should not appear"), result("error_during_execution")],
    {
      onYield: async (message) => {
        if (message.type === "result") h.ctx.currentTurn?.abortController.abort();
      },
    },
  );

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ledger.snapshot(), undefined, "the claim must not be left held");
  const texts = h.ctx.eventBuffer.filter((e) => e.type === "assistant_text").map((e) => e.text);
  assert.ok(!texts.includes("should not appear"), "nothing yielded after the abort fired should be processed");
});

test("a Stop before the query starts settles the claim and still completes the Turn", async () => {
  const h = makeTurnHarness([init(), result()]);
  // interrupt_at newer than the Command is what checkInterrupt acts on.
  h.relay.getSession = async () => ({ interrupt_at: new Date(Date.now() + 60_000).toISOString() });

  await runTurn(h.ctx, cmd("too late"));

  assert.equal(h.ledger.snapshot(), undefined, "the claim is not left behind");
  assert.equal(h.relay.lastReport, false);
  const status = h.ctx.eventBuffer.filter((e) => e.type === "status").map((e) => e.text);
  assert.ok(status.includes("turn stopped"));
  assert.ok(
    types(h).includes("turn_complete"),
    "the composer comes back even though no result arrived",
  );
});

test("a real Command's Turn completing records lastRealTurnCompletedAt", async () => {
  const h = makeTurnHarness([init(), assistantText("hello"), result()]);

  await runTurn(h.ctx, cmd("say hello"));

  assert.ok(h.ctx.state.lastRealTurnCompletedAt, "Auto-compact's idle clock needs this to be set");
});

test("the idle clock is armed when the result lands, not when the query finally drains", async () => {
  // Observed in production: the SDK generator can stay open long after the
  // Turn produced its `result` -- a Background task still running, a
  // subprocess slow to let go. Arming the clock only once the drain finished
  // left Auto-compact's countdown unstarted for as long as that took, so an
  // idle session never compacted at all.
  // The trailing message is only reached after a long pause, so the `result`
  // has already been delivered and handled: this stalls the drain, not the
  // reply the human is waiting on.
  const h = makeTurnHarness([init(), assistantText("hello"), result(), assistantText("tail")], {
    onYield: async (m) => {
      if (m.type === "assistant" && JSON.stringify(m).includes("tail")) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    },
  });

  const turn = runTurn(h.ctx, cmd("say hello"));
  await new Promise((r) => setTimeout(r, 500));

  assert.ok(
    h.ctx.state.lastRealTurnCompletedAt,
    "the idle stretch starts when the human got their answer",
  );
  await turn;
});

test("an Auto-compact Command's Turn does not move lastRealTurnCompletedAt, and skips the push", async () => {
  const h = makeTurnHarness([init(), assistantText("compacted"), result()]);

  await runTurn(h.ctx, cmd("/compact", undefined, "auto"));

  assert.equal(
    h.ctx.state.lastRealTurnCompletedAt,
    undefined,
    "an Auto-compact firing must not re-arm itself, or it would repeat forever",
  );
  const complete = h.ctx.eventBuffer.find((e) => e.type === "turn_complete");
  assert.equal(complete?.no_notify, true, "a routine idle compact is not worth a phone buzz");
});

test("a real Command steered into a running Auto-compact still counts as real activity", async () => {
  // loop.ts never submits Auto-compact while a Turn is in flight, so any
  // Command that reaches a Steer is, by construction, phone-originated --
  // confirming one is exactly the "a human showed up" signal that should
  // re-arm Auto-compact's idle clock, even though the Turn it steered *into*
  // was itself the Auto-compact.
  const steer = cmd("a real message");
  let steered = false;
  let h: TurnHarness;
  h = makeTurnHarness(
    [init(), assistantText("compacted"), result(), init("sdk-2"), assistantText("hi"), result()],
    {
      onYield: async (message) => {
        if (message.type === "result" && !steered) {
          steered = true;
          await h.ledger.current()!.steer(steer);
        }
      },
    },
  );

  await runTurn(h.ctx, cmd("/compact", undefined, "auto"));

  assert.ok(h.ctx.state.lastRealTurnCompletedAt, "the steered-in real Command should re-arm the idle clock");
  const completes = h.ctx.eventBuffer.filter((e) => e.type === "turn_complete");
  assert.equal(completes.length, 2);
  assert.equal(completes[0].no_notify, true, "Auto-compact's own sub-turn stays silent");
  assert.notEqual(
    completes[1].no_notify,
    true,
    "the human's own steered-in reply must still buzz -- it is not the routine idle compact",
  );
});

test("a Context-window warning fires once when the percentage crosses the default threshold", async () => {
  const h = makeTurnHarness([init(), assistantText("hello"), result()], {
    contextPercentages: [75],
  });

  await runTurn(h.ctx, cmd("say hello"));

  const complete = h.ctx.eventBuffer.find((e) => e.type === "turn_complete");
  assert.equal(complete?.context_percentage, 75);
  assert.equal(complete?.context_warning, true);
  assert.equal(h.ctx.contextWarningActive, true);
});

test("a Context-window warning stays below the default threshold silent", async () => {
  const h = makeTurnHarness([init(), assistantText("hello"), result()], {
    contextPercentages: [50],
  });

  await runTurn(h.ctx, cmd("say hello"));

  const complete = h.ctx.eventBuffer.find((e) => e.type === "turn_complete");
  assert.equal(complete?.context_warning, undefined);
  assert.equal(h.ctx.contextWarningActive, false);
});

test("contextWarningCrossing fires only on the Turn that first reaches the threshold", () => {
  const first = contextWarningCrossing(75, 70, false);
  assert.deepEqual(first, { fire: true, active: true });

  const second = contextWarningCrossing(80, 70, first.active);
  assert.deepEqual(second, { fire: false, active: true }, "stays silent while still over threshold");
});

test("contextWarningCrossing re-arms once the percentage drops back below threshold", () => {
  const crossed = contextWarningCrossing(75, 70, false);
  const dropped = contextWarningCrossing(50, 70, crossed.active);
  assert.deepEqual(dropped, { fire: false, active: false });

  const recrossed = contextWarningCrossing(80, 70, dropped.active);
  assert.deepEqual(recrossed, { fire: true, active: true }, "fires again on the second crossing");
});

test("a configured Context-window warning threshold overrides the default", async () => {
  const h = makeTurnHarness([init(), assistantText("hello"), result()], {
    contextPercentages: [60],
    config: { contextWarningThresholdPercent: 55 },
  });

  await runTurn(h.ctx, cmd("say hello"));

  const complete = h.ctx.eventBuffer.find((e) => e.type === "turn_complete");
  assert.equal(complete?.context_warning, true, "60% crosses the configured 55% threshold");
});

test("a Context-window overflow fires when the SDK's PreCompact hook reports an auto trigger, independently of the warning tier", async () => {
  let capturedOptions: Options | undefined;
  const h = makeTurnHarness([init(), assistantText("working"), compactBoundary(), result()], {
    contextPercentages: [80],
    onOptions: (options) => {
      capturedOptions = options;
    },
    onYield: async (message) => {
      if (message.type === "system" && (message as { subtype?: string }).subtype === "compact_boundary") {
        const hookInput = { hook_event_name: "PreCompact", trigger: "auto" } as unknown as HookInput;
        await capturedOptions?.hooks?.PreCompact?.[0]?.hooks[0]?.(hookInput, undefined, {
          signal: new AbortController().signal,
        });
      }
    },
  });

  await runTurn(h.ctx, cmd("first"));

  const overflow = h.ctx.eventBuffer.find((e) => e.context_overflow === true);
  assert.ok(overflow, "an unplanned compaction produces a context_overflow status event");
  assert.equal(overflow?.type, "status");
  const withWarning = h.ctx.eventBuffer.find((e) => e.context_warning === true);
  assert.ok(withWarning, "the same reading still independently crosses the warning threshold");
  assert.equal(
    h.ctx.contextWarningActive,
    true,
    "overflow firing must not suppress the independently-computed warning tier",
  );
});

test("a Context-window overflow does not fire for a manual PreCompact trigger", async () => {
  let capturedOptions: Options | undefined;
  const h = makeTurnHarness([init(), assistantText("working"), compactBoundary(), result()], {
    onOptions: (options) => {
      capturedOptions = options;
    },
    onYield: async (message) => {
      if (message.type === "system" && (message as { subtype?: string }).subtype === "compact_boundary") {
        const hookInput = { hook_event_name: "PreCompact", trigger: "manual" } as unknown as HookInput;
        await capturedOptions?.hooks?.PreCompact?.[0]?.hooks[0]?.(hookInput, undefined, {
          signal: new AbortController().signal,
        });
      }
    },
  });

  await runTurn(h.ctx, cmd("/compact"));

  const overflow = h.ctx.eventBuffer.find((e) => e.context_overflow === true);
  assert.equal(overflow, undefined, "a connector- or human-issued /compact is not an overflow");
});

test("a subprocess that dies mid-Turn leaves nothing held and says why", async () => {
  const h = makeTurnHarness([init(), assistantText("working"), result()], {
    throwAfter: { count: 2, error: new Error("subprocess exited") },
  });

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.relay.lastReport, false);
  const errors = h.ctx.eventBuffer.filter((e) => e.is_error).map((e) => e.text);
  assert.ok(errors.some((t) => /subprocess exited/.test(t!)));
});

test("an [ede_diagnostic]-tagged throw is logged, not banner'd -- it's the SDK's own internal marker, not a real failure", async () => {
  const h = makeTurnHarness([init(), assistantText("working"), result()], {
    throwAfter: {
      count: 2,
      error: new Error("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"),
    },
  });

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ctx.eventBuffer.some((e) => e.is_error), false);
});

test("context usage is stamped on the turn_complete and on a compaction", async () => {
  const h = makeTurnHarness([init(), compactBoundary(), result()]);

  await runTurn(h.ctx, cmd("/compact"));

  const stamped = h.ctx.eventBuffer.filter((e) => e.context_percentage !== undefined);
  assert.ok(stamped.length >= 1);
  assert.ok(stamped.every((e) => e.context_percentage === 42));
});

test("the SDK session id is persisted so the next Turn resumes the conversation", async () => {
  const h = makeTurnHarness([init("sdk-abc"), result()]);

  await runTurn(h.ctx, cmd("first"));

  assert.equal(h.ctx.sdkSessionId, "sdk-abc");
  assert.ok(h.written.some((s) => s.sdkSessionId === "sdk-abc"));
});

test("a Turn claimed from the hand-back buffer is promoted, not re-claimed", async () => {
  const h = makeTurnHarness([init(), result()]);
  const queued = cmd("queued work");
  await h.ledger.hold(queued, "queued");

  await runTurn(h.ctx, queued);

  assert.equal(h.ledger.snapshot(), undefined);
  assert.equal(h.ledger.cursor, queued.seq, "the cursor did not advance twice");
  assert.deepEqual(h.relay.reports, [true, false]);
});

/** A repository the Turn below can commit into, so the report is measured from real history. */
function makeRepo(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-turn-repo-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  if (origin) run("remote", "add", "origin", origin);
  writeFileSync(join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-q", "-m", "initial");
  return dir;
}

test("a Turn that committed reports it once, attributed to the repo", async () => {
  const dir = makeRepo("git@github.com:acme/widgets.git");
  const h = makeTurnHarness([init(), assistantText("committing"), result()], {
    projectDir: dir,
    onYield: async (message) => {
      if (message.type !== "result") return;
      writeFileSync(join(dir, "feature.ts"), "one\ntwo\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "feature"], { cwd: dir });
    },
  });

  await runTurn(h.ctx, cmd("build the feature"));

  assert.deepEqual(h.relay.contributions, [
    { host: "github.com", repo: "acme/widgets", added: 2, deleted: 0 },
  ]);
});

test("a Turn that committed nothing reports nothing", async () => {
  const h = makeTurnHarness([init(), assistantText("just talking"), result()], {
    projectDir: makeRepo(),
  });

  await runTurn(h.ctx, cmd("what does this do?"));

  assert.deepEqual(h.relay.contributions, []);
});

test("a successful Turn posts a usage event with its cost and token counts", async () => {
  const h = makeTurnHarness([
    init(),
    assistantText("hello"),
    result("success", {
      total_cost_usd: 0.042,
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 15,
    }),
  ]);

  await runTurn(h.ctx, cmd("say hello"));

  const usage = h.ctx.eventBuffer.filter((e) => e.type === "usage");
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], {
    type: "usage",
    cost_usd: 0.042,
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 15,
    repo: undefined,
  });
});

test("an errored Turn still posts a usage event -- usage isn't lost just because the Turn failed", async () => {
  const h = makeTurnHarness([
    init(),
    assistantText("working"),
    result("error_during_execution", { total_cost_usd: 0.01, input_tokens: 500 }),
  ]);

  await runTurn(h.ctx, cmd("do something risky"));

  const usage = h.ctx.eventBuffer.filter((e) => e.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].cost_usd, 0.01);
  assert.equal(usage[0].input_tokens, 500);
});

test("a Turn that committed nothing still posts usage, attributed to the repo", async () => {
  const dir = makeRepo("git@github.com:acme/widgets.git");
  const h = makeTurnHarness([init(), assistantText("just talking"), result()], {
    projectDir: dir,
  });

  await runTurn(h.ctx, cmd("what does this do?"));

  assert.deepEqual(h.relay.contributions, [], "nothing was committed");
  const usage = h.ctx.eventBuffer.find((e) => e.type === "usage");
  assert.ok(usage, "usage is reported regardless of whether anything was committed");
  assert.equal(usage!.repo, "github.com#acme/widgets", "same attribution Contributions uses");
});

test("a Steer produces a usage event per sub-turn, each carrying the same repo attribution", async () => {
  const dir = makeRepo("git@github.com:acme/widgets.git");
  const steer = cmd("a correction");
  let h: TurnHarness;
  h = makeTurnHarness(
    [init(), assistantText("working"), result(), init("sdk-2"), assistantText("corrected"), result()],
    {
      projectDir: dir,
      onYield: async (message) => {
        if (message.type === "result" && !h.ledger.current()?.pendingSteerSeq) {
          await h.ledger.current()!.steer(steer);
        }
      },
    },
  );

  await runTurn(h.ctx, cmd("first"));

  const usage = h.ctx.eventBuffer.filter((e) => e.type === "usage");
  assert.equal(usage.length, 2);
  assert.ok(usage.every((e) => e.repo === "github.com#acme/widgets"));
});
