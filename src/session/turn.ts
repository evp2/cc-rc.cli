import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, userTextMessage } from "../sdk/asyncQueue";
import { PERMISSION_MODE } from "../config";
import { SessionEndedError, type CommandRecord } from "../relay/client";
import { persist, publishSkills, trackBackgroundTasks } from "./commands";
import { attributionKey, measureContribution, readPosition, type Position } from "./contribution";
import type { SessionContext } from "./context";
import { checkInterrupt, makeCanUseTool, watchForInterrupt } from "./watchers";
import { selectLocalCommands, selectSkills } from "../skills";

/**
 * Runs a Turn to completion -- which, once a Steer lands, is really a chain
 * of Turns inside one query: this keeps draining the same generator across
 * the seam, promoting whichever Command the SDK's fresh `system:init`
 * confirms it moved on to, until a sub-turn ends having taken no further
 * Steer.
 *
 * The whole body runs inside the in-flight scope, which sweeps whatever
 * claims are still held however this function exits. Nothing below unwinds a
 * claim by hand.
 */
export async function runTurn(ctx: SessionContext, command: CommandRecord): Promise<void> {
  const text = command.text;
  const abortController = new AbortController();
  ctx.currentTurn = { abortController, steeredThisSubTurn: false };
  // Whether this Turn chain should count as "a human showed up" for
  // Auto-compact's idle clock. Starts true for any ordinary Command; an
  // Auto-compact's own initiating Command does not count, but a Steer
  // confirmed during its Turn does -- loop.ts never submits an Auto-compact
  // while a Turn is already in flight, so any Command that reaches a Steer is
  // phone-originated by construction. Also gates the push notification: a
  // routine idle Auto-compact should stay silent, but the human's own
  // steered-in request must not, so this flipping true is what turns the
  // suppression back off for the rest of the chain.
  let sawRealActivity = command.source !== "auto";
  const canUseTool = makeCanUseTool(ctx);
  // Streaming-input mode: the prompt is an async iterable rather than the
  // plain text, held open for the turn's duration. Nothing else feeds it
  // yet -- that's what lets a later Command be streamed into a Turn already
  // running (a Steer) instead of restarting the query, which the SDK only
  // accepts a mid-turn message into when the query began this way.
  const input = new AsyncQueue<SDKUserMessage>();
  input.push(userTextMessage(text));
  const options: Options = {
    // Without this the SDK sends a minimal system prompt that never states
    // the working directory, so `cwd` below is honoured by the subprocess but
    // invisible to the model: asked for "a file named x.txt" it has nothing to
    // resolve the name against and guesses an absolute path -- in practice the
    // home directory, outside the project entirely.
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: PERMISSION_MODE,
    allowDangerouslySkipPermissions: true,
    cwd: ctx.config.projectDir,
    env: ctx.providerEnv,
    abortController,
    canUseTool,
    ...(ctx.sdkSessionId ? { resume: ctx.sdkSessionId } : {}),
  };

  // Read before any of the Turn's work starts, so the range below spans
  // everything it committed -- including a Steer's sub-turns, which are part
  // of the same Turn chain and the same piece of work.
  const positionBefore = await readPosition(ctx.config.projectDir);
  // Read once and reused on every usage Event this Turn (and any of its Steer
  // sub-turns) posts -- the working directory's remote does not change
  // mid-Turn, so there is no reason to re-derive it per `result` message.
  const repo = await attributionKey(ctx.config.projectDir);

  await ctx.inFlight.duringTurn(command, abortController.signal, async (claims) => {
    // A stop counts if it was issued after the command it targets -- not after
    // the turn started. Turns run one at a time, so a command can sit queued
    // for minutes; stopping during that wait must still cancel it, and both
    // timestamps come from the relay, so the comparison needs no clock sync.
    const turnStartedAt = Date.now();
    const sinceMs = Date.parse(command.created_at) || turnStartedAt;
    const stopWatching = watchForInterrupt(ctx, abortController, sinceMs);
    await checkInterrupt(ctx, abortController, sinceMs);

    let sawResult = false;
    try {
      if (abortController.signal.aborted) throw new Error("stopped before starting");
      const activeQuery = ctx.query({ prompt: input, options });
      // Live for the persistent kill-watcher to act against for as long as
      // this turn's subprocess is -- which can outlast the turn's own
      // `result` while one of its Background tasks is still running.
      ctx.currentQuery = activeQuery;
      for await (const message of activeQuery) {
        // A Stop can land while the SDK's generator is mid-yield, and it is
        // not trusted to end cleanly on its own once the transport it was
        // reading from is gone -- observed in production as an endless run of
        // "Query closed"/"ProcessTransport is not ready for writing" from the
        // getContextUsage call below, with duringTurn's claim-settling
        // `finally` never reached because this loop never stopped consuming.
        // Bailing out here bounds it by the signal regardless of what the
        // generator does; `for await` calls the iterator's `return()` on the
        // way out, so the underlying query is told to stop too.
        if (abortController.signal.aborted) break;
        if (message.type === "system" && message.subtype === "init") {
          ctx.sdkSessionId = message.session_id;
          persist(ctx, { sdkSessionId: ctx.sdkSessionId });
          // A confirmed Steer is always phone-originated (see sawRealActivity
          // above), so checked before confirmSteer() clears the pending flag.
          if (claims.pendingSteerSeq) sawRealActivity = true;
          // A second (or third, ...) `init` inside this same query means a
          // Steer just landed: promote whichever Command was streamed in to
          // `running` and make it the one this loop is now tracking. A no-op
          // on the very first `init`, where nothing is pending yet.
          claims.confirmSteer();
          // Each sub-turn gets its own allowance to be Steered again -- a
          // steered exchange is a conversation, not a single correction.
          if (ctx.currentTurn) ctx.currentTurn.steeredThisSubTurn = false;
          // Refresh from a subprocess already running this turn -- free, since
          // supportedCommands() just reads the initialize response it already
          // has. Skills discovered mid-session (e.g. the agent cd's into a
          // subdirectory with its own .claude/skills) show up on the next turn
          // rather than needing a connector restart.
          const initSkills = message.skills ?? [];
          void activeQuery
            .supportedCommands()
            .then((commands) =>
              publishSkills(
                ctx,
                selectSkills(commands, initSkills),
                selectLocalCommands(commands, initSkills),
              ),
            )
            .catch((e) => console.error("Failed to refresh skills:", (e as Error).message));
        }
        // Read before settling this sub-turn below, so both the "steered"
        // marker and the no-push flag reflect the same fact: a Steer was
        // streamed in and not yet confirmed at the moment this sub-turn's own
        // outcome arrived. Neutral wording, not "interrupted" -- a Steer can
        // also land just as a Turn was finishing on its own, and only
        // "steered" is true in both cases.
        const steered = message.type === "result" && !!claims.pendingSteerSeq;
        if (message.type === "result") {
          sawResult = true;
          // This sub-turn just ended. If a Steer landed, its claim is already
          // held (added `queued` by watchForSteers) and gets promoted on the
          // next `init` above, so settling this one doesn't make the
          // relay-facing fact flicker false in between.
          await claims.settleActive();
          // Auto-compact's idle stretch starts here, at the moment the human
          // got their answer -- not after the drain below finishes. The
          // generator can stay open well past its own `result` while a
          // Background task runs on, and a countdown that only starts then is
          // a countdown that may never start at all.
          if (sawRealActivity) persist(ctx, { lastRealTurnCompletedAt: new Date().toISOString() });
        }
        const mapped = ctx.mapMessage(message);
        if (message.type === "result") {
          const usageEvent = mapped.find((evt) => evt.type === "usage");
          if (usageEvent) usageEvent.repo = repo;
        }
        // A turn's own end and a mid-turn compaction are the only two moments
        // the context window's fill level actually changes, so those are the
        // only points this is refreshed. Best-effort: never let a stat fail
        // the turn it is reporting on.
        if (
          (message.type === "result" && message.subtype === "success") ||
          (message.type === "system" && message.subtype === "compact_boundary")
        ) {
          try {
            const { percentage } = await activeQuery.getContextUsage();
            const target = mapped.find(
              (evt) => evt.type === "turn_complete" || evt.type === "status",
            );
            if (target) target.context_percentage = Math.round(percentage);
          } catch (e) {
            console.error("Failed to get context usage:", (e as Error).message);
          }
        }
        // A phone push is skipped both when this sub-turn took an unconfirmed
        // Steer (the human already knows work didn't finish quietly) and for
        // an Auto-compact's own routine turn_complete -- but not for a real
        // Command steered into a running Auto-compact, whose own outcome the
        // human is still owed a buzz for. `!sawRealActivity` is what tells the
        // two apart: it is still false here for Auto-compact's own sub-turns,
        // and already true by the time a steered-in real sub-turn settles.
        if (steered || (command.source === "auto" && !sawRealActivity)) {
          for (const evt of mapped) {
            if (evt.type === "turn_complete") evt.no_notify = true;
          }
        }
        if (steered) {
          ctx.eventBuffer.push({ type: "status", text: "steered" });
        }
        trackBackgroundTasks(ctx, mapped);
        ctx.eventBuffer.push(...mapped);
      }
    } catch (e) {
      // An abort is a normal outcome, not a failure: report it as a completed
      // turn so the phone re-enables its composer instead of showing an error.
      if (abortController.signal.aborted) {
        console.log("Turn stopped.");
      } else {
        console.error("Turn failed:", (e as Error).message);
        // A `result` message (mapped to turn_complete/error by mapSdkMessage)
        // already reported this turn's outcome -- avoid a redundant second
        // error event for the same failure when the query() generator also
        // rejects after streaming it.
        if (!sawResult) {
          ctx.eventBuffer.push({ type: "error", text: (e as Error).message, is_error: true });
        }
      }
    } finally {
      // Nothing else will ever feed this turn's prompt once it has settled --
      // closing it lets the stream end cleanly instead of leaving the SDK
      // holding an input source that will never produce anything further.
      input.close();
      stopWatching();
      // The generator is drained (or aborted) by this point, so its subprocess
      // is done and there is nothing left for a Kill to act against here.
      ctx.currentQuery = undefined;
      // The SDK may or may not emit a `result` for an aborted turn. Emitting
      // turn_complete unconditionally on abort guarantees the phone's composer
      // comes back; a duplicate divider is far cheaper than a stuck UI.
      if (abortController.signal.aborted) {
        ctx.eventBuffer.push({ type: "status", text: "turn stopped" });
        if (!sawResult) {
          ctx.eventBuffer.push({
            type: "turn_complete",
            duration_ms: Date.now() - turnStartedAt,
          });
        }
      }
      ctx.currentTurn = undefined;
    }
  });

  await reportContribution(ctx, positionBefore);
}

/**
 * Tells the relay what this Turn committed, if anything. Runs after the
 * in-flight scope has closed, so a slow git or a slow relay cannot hold the
 * phone's brake on past the work it describes.
 *
 * Best-effort in every direction: a Turn that committed nothing reports
 * nothing, and a report that fails is dropped rather than retried or
 * remembered. A Turn stopped part-way still reports -- the commits it made
 * before the brake are as real as any others.
 */
async function reportContribution(
  ctx: SessionContext,
  positionBefore: Position | undefined,
): Promise<void> {
  try {
    const contribution = await measureContribution(ctx.config.projectDir, positionBefore);
    if (!contribution) return;
    await ctx.client.postContribution(contribution);
  } catch (e) {
    if (e instanceof SessionEndedError) return;
    console.error("Failed to report contribution:", (e as Error).message);
  }
}
