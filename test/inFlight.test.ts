import assert from "node:assert/strict";
import { test } from "node:test";

import { cmd, makeLedger } from "./doubles.ts";

test("holding the first Command reports in flight once, and settling it reports false once", async () => {
  const { ledger, relay } = makeLedger();

  await ledger.hold(cmd("first"), "running");
  await ledger.hold(cmd("second"), "queued");
  assert.deepEqual(relay.reports, [true], "a run of queued work reads as continuous");

  const [first, second] = ledger.snapshot()!;
  await ledger.settle(first.seq);
  assert.deepEqual(relay.reports, [true], "still holding the second");
  await ledger.settle(second.seq);
  assert.deepEqual(relay.reports, [true, false]);
});

test("holding advances the cursor with the claim, in one patch", async () => {
  const { ledger, patches } = makeLedger();

  await ledger.hold(cmd("only", "c-42"), "running");

  assert.equal(ledger.cursor, "c-42");
  const last = patches[patches.length - 1];
  assert.equal(last.commandCursor, "c-42");
  assert.deepEqual(last.inFlight, [{ seq: "c-42", text: "only", status: "running" }]);
});

test("the state mirror drops the field entirely once nothing is held", async () => {
  const { ledger, patches } = makeLedger();
  const c = cmd("only");

  await ledger.hold(c, "running");
  await ledger.settle(c.seq);

  assert.equal(patches[patches.length - 1].inFlight, undefined);
  assert.equal(ledger.snapshot(), undefined);
});

test("a Turn that ends holding an unconfirmed Steer settles it rather than leaking it", async () => {
  // The originating bug. A Local command streamed into a running Turn is
  // answered by the CLI itself, which ends the query without ever emitting the
  // fresh `init` that would confirm the Steer.
  const { ledger, relay } = makeLedger();
  const controller = new AbortController();

  await ledger.duringTurn(cmd("first"), controller.signal, async (claims) => {
    await claims.steer(cmd("/compact"));
    await claims.settleActive();
    // ...and the query ends. No second init ever arrives.
  });

  assert.equal(ledger.snapshot(), undefined, "nothing is still held");
  assert.equal(ledger.current(), undefined);
  assert.equal(relay.lastReport, false, "the phone's brake is released");
});

test("an unconfirmed Steer under Stop is discarded, and says so on the phone", async () => {
  const { ledger, relay, emitted } = makeLedger();
  const controller = new AbortController();

  await ledger.duringTurn(cmd("first"), controller.signal, async (claims) => {
    await claims.steer(cmd("a correction"));
    controller.abort();
  });

  assert.equal(ledger.snapshot(), undefined);
  assert.equal(relay.lastReport, false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "command_discarded");
  assert.equal(emitted[0].text, "a correction");
});

test("a Turn whose body throws still leaves nothing held", async () => {
  const { ledger, relay } = makeLedger();
  const controller = new AbortController();

  await assert.rejects(
    ledger.duringTurn(cmd("first"), controller.signal, async (claims) => {
      await claims.steer(cmd("a correction"));
      throw new Error("subprocess died");
    }),
    /subprocess died/,
  );

  assert.equal(ledger.snapshot(), undefined);
  assert.equal(ledger.current(), undefined);
  assert.equal(relay.lastReport, false);
});

test("a confirmed Steer becomes the active Command and is settled by its own result", async () => {
  const { ledger, relay } = makeLedger();
  const controller = new AbortController();
  const steer = cmd("a correction");

  await ledger.duringTurn(cmd("first"), controller.signal, async (claims) => {
    await claims.steer(steer);
    await claims.settleActive(); // the truncated Turn's own result
    claims.confirmSteer(); // the fresh init
    assert.equal(claims.activeSeq, steer.seq);
    assert.equal(claims.pendingSteerSeq, undefined);
    assert.deepEqual(ledger.snapshot(), [{ seq: steer.seq, text: "a correction", status: "running" }]);
    await claims.settleActive(); // the steered Turn's own result
  });

  assert.equal(ledger.snapshot(), undefined);
  // Never flickers false across the seam between the two Turns: the Steer was
  // already held when the truncated Turn settled.
  assert.deepEqual(relay.reports, [true, false]);
});

test("a Steer that never reached the query is dropped, not left claimed", async () => {
  const { ledger, relay, emitted } = makeLedger();
  const controller = new AbortController();

  await ledger.duringTurn(cmd("first"), controller.signal, async (claims) => {
    await claims.steer(cmd("a correction"));
    await claims.abandonSteer();
    assert.equal(claims.pendingSteerSeq, undefined);
    await claims.settleActive();
  });

  assert.equal(ledger.snapshot(), undefined);
  assert.equal(relay.lastReport, false);
  assert.equal(emitted[0].type, "command_discarded");
  assert.equal(emitted[0].text, "a correction");
});

test("a hand-back Command already held queued is promoted, not re-held", async () => {
  const { ledger, patches } = makeLedger();
  const later = cmd("queued work");
  await ledger.hold(later, "queued");
  const patchCountBefore = patches.length;

  await ledger.duringTurn(later, new AbortController().signal, async (claims) => {
    assert.equal(claims.activeSeq, later.seq);
    assert.deepEqual(ledger.snapshot(), [
      { seq: later.seq, text: "queued work", status: "running" },
    ]);
  });

  assert.equal(ledger.cursor, later.seq, "the cursor did not move again");
  assert.ok(patches.length > patchCountBefore);
});

test("current() identifies the live Turn, so a stale poll cannot mis-claim", async () => {
  const { ledger } = makeLedger();
  let captured: unknown;

  await ledger.duringTurn(cmd("first"), new AbortController().signal, async (claims) => {
    captured = claims;
    assert.equal(ledger.current(), claims);
  });

  assert.equal(ledger.current(), undefined);
  assert.notEqual(ledger.current(), captured);
});

test("resumeFrom explains what a dead process held, and corrects the relay", async () => {
  const { ledger, relay, emitted, patches } = makeLedger();

  await ledger.resumeFrom([
    { seq: "c1", text: "the interrupted one", status: "running" },
    { seq: "c2", text: "the queued one", status: "queued" },
  ]);

  assert.equal(emitted.length, 2);
  assert.match(emitted[0].text!, /previous turn was interrupted/);
  assert.match(emitted[1].text!, /queued command was dropped/);
  assert.ok(emitted.every((e) => e.is_error));
  assert.equal(patches[patches.length - 1].inFlight, undefined);
  assert.deepEqual(relay.reports, [false]);
});

test("resumeFrom says nothing when the previous process held nothing", async () => {
  const { ledger, relay, emitted } = makeLedger();

  await ledger.resumeFrom(undefined);
  await ledger.resumeFrom([]);

  assert.deepEqual(emitted, []);
  assert.deepEqual(relay.reports, [], "no report, so a fresh session is not told anything");
});

test("reconcileOnce re-asserts the current truth even when nothing changed", async () => {
  const { ledger, relay } = makeLedger();

  await ledger.reconcileOnce();
  await ledger.hold(cmd("first"), "running");
  await ledger.reconcileOnce();

  assert.deepEqual(relay.reports, [false, true, true]);
});

test("a failed report is survivable, and the next reconcile repairs it", async () => {
  const { ledger, relay } = makeLedger();

  relay.failNextReport = new Error("network down");
  await ledger.hold(cmd("first"), "running"); // report swallowed
  assert.deepEqual(relay.reports, [], "the failure did not take the turn down");

  await ledger.reconcileOnce();
  assert.deepEqual(relay.reports, [true], "the stranded flag self-heals");
});

test("the cursor survives a restart", async () => {
  const { ledger } = makeLedger({ cursor: "c-99" });
  assert.equal(ledger.cursor, "c-99");
});
