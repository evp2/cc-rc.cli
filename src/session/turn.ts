import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, userTextMessage } from "../sdk/asyncQueue";
import { PERMISSION_MODE } from "../config";
import { query } from "../sdk/client";
import type { CommandRecord } from "../relay/client";
import {
  discard,
  persist,
  promoteToRunning,
  publishSkills,
  release,
  trackBackgroundTasks,
} from "./commands";
import type { SessionContext } from "./context";
import { checkInterrupt, makeCanUseTool, watchForInterrupt } from "./watchers";
import { selectLocalCommands, selectSkills } from "../skills";

/**
 * Runs a Turn to completion -- which, once a Steer lands, is really a chain
 * of Turns inside one query: this keeps draining the same generator across
 * the seam, promoting whichever Command the SDK's fresh `system:init`
 * confirms it moved on to, until a sub-turn ends having taken no further
 * Steer.
 */
export async function runTurn(ctx: SessionContext, command: CommandRecord): Promise<void> {
  const text = command.text;
  const abortController = new AbortController();
  ctx.currentTurn = { abortController, activeSeq: command.seq, steeredThisSubTurn: false };
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
    const activeQuery = query({ prompt: input, options });
    // Live for the persistent kill-watcher to act against for as long as
    // this turn's subprocess is -- which can outlast the turn's own
    // `result` while one of its Background tasks is still running.
    ctx.currentQuery = activeQuery;
    for await (const message of activeQuery) {
      if (message.type === "system" && message.subtype === "init") {
        ctx.sdkSessionId = message.session_id;
        persist(ctx, { sdkSessionId: ctx.sdkSessionId });
        // A second (or third, ...) `init` inside this same query means a
        // Steer just landed: promote whichever Command was streamed in to
        // `running` and make it the one this loop is now tracking. A no-op
        // on the very first `init`, where nothing is pending yet.
        if (ctx.currentTurn?.pendingSteerSeq) {
          promoteToRunning(ctx, ctx.currentTurn.pendingSteerSeq);
          ctx.currentTurn.activeSeq = ctx.currentTurn.pendingSteerSeq;
          ctx.currentTurn.pendingSteerSeq = undefined;
        }
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
      // Set before mapping this message, so both the "steered" marker and
      // the no-push flag below read the same fact: a Steer was streamed in
      // and not yet confirmed at the moment this sub-turn's own outcome
      // arrived. Neutral wording, not "interrupted" -- a Steer can also
      // land just as a Turn was finishing on its own, and only "steered" is
      // true in both cases.
      const steered = message.type === "result" && !!ctx.currentTurn?.pendingSteerSeq;
      if (message.type === "result") {
        sawResult = true;
        // This sub-turn just ended. If a Steer landed, its entry is already
        // in the in-flight set (added `queued` by watchForSteers) and gets
        // promoted on the next `init` above, so releasing this one doesn't
        // make the relay-facing fact flicker false in between.
        if (ctx.currentTurn) await release(ctx, ctx.currentTurn.activeSeq);
      }
      const mapped = ctx.mapMessage(message);
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
      if (steered) {
        for (const evt of mapped) {
          if (evt.type === "turn_complete") evt.no_notify = true;
        }
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
    if (ctx.currentTurn) {
      // A Steer streamed in but never confirmed by a fresh `init` before this
      // query ended -- which is ordinary, not exceptional: a Local command
      // (`/compact`) streamed into a running Turn is answered by the CLI
      // itself, which reports a compact_boundary and a result and then ends
      // the query, never a fresh `init`. Under Stop it is discarded, visibly:
      // the brake starting fresh work is not a brake. Otherwise it reached
      // the SDK and was absorbed into the Turn that just ended, so it is
      // simply done and the claim has to go.
      //
      // Leaving it for a restart to report is not an option either way. This
      // block only runs because the process is alive; a genuine crash skips
      // it entirely and the state file still carries the entry for the next
      // start. Held here, it would sit in the in-flight set for the life of
      // the process, with the reconcile timer re-asserting in_flight true
      // every few seconds against a session that finished long ago.
      if (ctx.currentTurn.pendingSteerSeq) {
        if (abortController.signal.aborted) {
          await discard(ctx, ctx.currentTurn.pendingSteerSeq);
        } else {
          await release(ctx, ctx.currentTurn.pendingSteerSeq);
        }
      }
      // Idempotent: already released by the `result` handling above in the
      // ordinary case, so this only does anything for an abort or an
      // unexpected error that left the active entry behind.
      await release(ctx, ctx.currentTurn.activeSeq);
    }
    ctx.currentTurn = undefined;
  }
}
