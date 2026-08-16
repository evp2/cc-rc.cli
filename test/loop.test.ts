import assert from "node:assert/strict";
import { test } from "node:test";

import { isAutoCompactDue, maybeSubmitAutoCompact } from "../src/session/loop.ts";
import { SessionEndedError } from "../src/relay/client.ts";
import { makeTurnHarness } from "./doubles.ts";

const CFG = { afterMinutes: 30 };
const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

test("never due before any real Turn has completed", () => {
  assert.equal(isAutoCompactDue({}, CFG, NOW), false);
});

test("not yet due before the threshold elapses", () => {
  assert.equal(isAutoCompactDue({ lastRealTurnCompletedAt: minutesAgo(29) }, CFG, NOW), false);
});

test("due once the threshold has elapsed", () => {
  assert.equal(isAutoCompactDue({ lastRealTurnCompletedAt: minutesAgo(30) }, CFG, NOW), true);
});

test("not due again until a real Turn has completed since the last Auto-compact", () => {
  const state = { lastRealTurnCompletedAt: minutesAgo(60), lastAutoCompactAt: minutesAgo(1) };
  assert.equal(isAutoCompactDue(state, CFG, NOW), false);
});

test("due again once a real Turn completes after the last Auto-compact", () => {
  const state = { lastRealTurnCompletedAt: minutesAgo(31), lastAutoCompactAt: minutesAgo(90) };
  assert.equal(isAutoCompactDue(state, CFG, NOW), true);
});

test("maybeSubmitAutoCompact does nothing when the feature is unconfigured", async () => {
  const h = makeTurnHarness([]);
  h.ctx.state.lastRealTurnCompletedAt = minutesAgo(60);

  await maybeSubmitAutoCompact(h.ctx);

  assert.deepEqual(h.relay.postedCommands, []);
});

test("maybeSubmitAutoCompact submits and persists lastAutoCompactAt once due", async () => {
  const h = makeTurnHarness([], { config: { inactivityCompact: CFG } });
  h.ctx.state.lastRealTurnCompletedAt = new Date(NOW - 31 * 60_000).toISOString();

  await maybeSubmitAutoCompact(h.ctx);

  assert.deepEqual(h.relay.postedCommands, ["/compact"]);
  assert.ok(h.ctx.state.lastAutoCompactAt, "so the same idle stretch doesn't fire twice");
});

test("maybeSubmitAutoCompact does not persist lastAutoCompactAt when the submission fails", async () => {
  const h = makeTurnHarness([], { config: { inactivityCompact: CFG } });
  h.ctx.state.lastRealTurnCompletedAt = new Date(NOW - 31 * 60_000).toISOString();
  h.relay.failNextPostCommand = new Error("network blip");

  await maybeSubmitAutoCompact(h.ctx);

  assert.equal(h.ctx.state.lastAutoCompactAt, undefined, "a failed submission must retry, not be treated as fired");
});

test("maybeSubmitAutoCompact swallows a SessionEndedError like every other best-effort relay call", async () => {
  const h = makeTurnHarness([], { config: { inactivityCompact: CFG } });
  h.ctx.state.lastRealTurnCompletedAt = new Date(NOW - 31 * 60_000).toISOString();
  h.relay.failNextPostCommand = new SessionEndedError();

  await assert.doesNotReject(maybeSubmitAutoCompact(h.ctx));
});
