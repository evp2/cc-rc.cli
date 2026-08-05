import assert from "node:assert/strict";
import { test } from "node:test";

import { runTurn } from "../src/session/turn.ts";
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
