import type { CanUseTool, PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, userTextMessage } from "../sdk/asyncQueue";
import { SessionEndedError, type CommandRecord } from "../relay/client";
import type { SessionContext } from "./context";

// How often a running turn checks whether the phone has asked it to stop.
// Bounds how long "Stop" takes to visibly do something.
export const INTERRUPT_POLL_INTERVAL_MS = 1000;

/**
 * Actions a phone's Kill against whichever Query is currently live, running
 * for the connector's whole lifetime rather than scoped to one turn --
 * unlike {@link watchForInterrupt}, which only needs to watch while its own
 * turn is running, a Background task can outlive the turn that spawned it,
 * so Kill must stay actionable between turns too. Idempotent: `stopTask` on
 * an already-settled or unknown task is a no-op.
 */
export function watchForKills(ctx: SessionContext): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const session = await ctx.client.getSession({ heartbeat: true });
        const kill = session.kill_task;
        if (kill && kill.requested_at !== ctx.lastHandledKillAt && ctx.currentQuery) {
          ctx.lastHandledKillAt = kill.requested_at;
          console.log(`Kill requested for background task ${kill.task_id}.`);
          await ctx.currentQuery.stopTask(kill.task_id);
        }
      } catch (e) {
        // A dead relay is the main loop's problem; a transient failure retries
        // on the next tick, exactly like the interrupt watcher.
        if (!(e instanceof SessionEndedError)) {
          console.error("Kill watcher poll failed:", (e as Error).message);
        }
      }
    })();
  }, INTERRUPT_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Turn-scoped in spirit, persistent in shape -- ticking for the connector's
 * whole lifetime like {@link watchForKills}, but a no-op whenever
 * `ctx.currentTurn` is unset, which is most of the time between Turns.
 * Sharing one persistent timer is simpler than starting and stopping a fresh
 * one per Turn, and correctness comes from the `currentTurn`/`questionPending`
 * checks below, not from when the timer itself runs.
 *
 * Finds at most one Command to Steer with per tick, and only when this
 * sub-turn hasn't already taken one. Everything else the poll returns --
 * later Commands in the same batch, or any Command once the one Steer is
 * spent -- goes to the hand-back buffer and runs in order as ordinary Turns
 * once the current one ends.
 */
export function watchForSteers(ctx: SessionContext): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const held = ctx.inFlight.current();
      const turn = ctx.currentTurn;
      if (!held || !turn || !ctx.currentQuery) return;
      if (turn.abortController.signal.aborted) return;
      if (ctx.questionPending) return;

      let commands: CommandRecord[];
      try {
        commands = await ctx.client.pollCommands(ctx.inFlight.cursor);
      } catch (e) {
        if (!(e instanceof SessionEndedError)) {
          console.error("Steer poll failed:", (e as Error).message);
        }
        return;
      }
      if (commands.length === 0) return;
      // Stop or a Question can have landed while that poll was in flight --
      // re-check against the same claims handle this tick started for, not
      // fresh globals. The handle is the Turn's identity, so a stale response
      // from a poll started under a Turn that has since ended can never
      // mis-claim anything.
      if (
        ctx.inFlight.current() !== held ||
        turn.abortController.signal.aborted ||
        ctx.questionPending
      ) {
        return;
      }

      const [first, ...rest] = commands;
      if (!turn.steeredThisSubTurn) {
        turn.steeredThisSubTurn = true;
        await held.steer(first);
        if (turn.abortController.signal.aborted) {
          // Stop landed in the gap between claiming and streaming it in --
          // discard rather than deliver into a query that is already ending.
          await held.abandonSteer();
        } else {
          const steerInput = new AsyncQueue<SDKUserMessage>();
          steerInput.push(userTextMessage(first.text, { priority: "now" }));
          steerInput.close();
          try {
            await ctx.currentQuery.streamInput(steerInput);
          } catch (e) {
            // It never reached the query, so no `init` is ever coming to
            // confirm it and no Turn will ever end holding it. Said out loud
            // and released here rather than left claimed: a Command that
            // silently neither runs nor comes back is worse than one the
            // human can see didn't make it and send again.
            console.error("Failed to stream a Steer into the turn:", (e as Error).message);
            await held.abandonSteer();
          }
        }
      } else {
        await ctx.inFlight.hold(first, "queued");
        ctx.handBackBuffer.push(first);
      }
      for (const extra of rest) {
        await ctx.inFlight.hold(extra, "queued");
        ctx.handBackBuffer.push(extra);
      }
    })();
  }, INTERRUPT_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Aborts `controller` if the phone has asked to stop since `sinceMs`.
 *
 * Only a request newer than `sinceMs` counts, so a stop aimed at an earlier
 * turn -- or one that lands just as a turn finishes -- can never kill the
 * next one. Poll failures are ignored: the watcher retries a second later,
 * and a genuinely dead relay is the main loop's problem.
 */
export async function checkInterrupt(
  ctx: SessionContext,
  controller: AbortController,
  sinceMs: number,
): Promise<void> {
  if (controller.signal.aborted) return;
  try {
    // Doubles as the connector's liveness heartbeat: during a turn this is
    // the only relay traffic, since events flush only when there are events.
    const session = await ctx.client.getSession({ heartbeat: true });
    const at = session.interrupt_at ? Date.parse(session.interrupt_at) : 0;
    if (at > sinceMs) {
      console.log("Stop requested from the phone, aborting the current turn.");
      controller.abort();
    }
  } catch (e) {
    if (e instanceof SessionEndedError) controller.abort();
  }
}

export function watchForInterrupt(
  ctx: SessionContext,
  controller: AbortController,
  sinceMs: number,
): () => void {
  const timer = setInterval(() => {
    void checkInterrupt(ctx, controller, sinceMs);
  }, INTERRUPT_POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Holds one `AskUserQuestion` tool call open until a matching Answer
 * arrives, polling the same way {@link checkInterrupt} does. `signal` is
 * the SDK's own per-call abort signal -- tied to the turn's abortController,
 * so a Stop tapped while a Question is pending resolves this the same way
 * it cancels everything else in the turn, with no special case
 * on either side.
 */
function waitForAnswer(
  ctx: SessionContext,
  input: Record<string, unknown>,
  toolUseId: string,
  signal: AbortSignal,
): Promise<PermissionResult> {
  return new Promise<PermissionResult>((resolve) => {
    // Checked before anything below is set up: an already-aborted signal
    // (Stop landed just as this tool call did) needs no listener and no
    // poll, and finish() below assumes `timer` exists, so resolving
    // directly here -- rather than through finish() -- avoids referencing
    // it before it's assigned.
    if (signal.aborted) {
      resolve({ behavior: "deny", message: "turn stopped", interrupt: true });
      return;
    }

    let settled = false;
    const finish = (result: PermissionResult) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ behavior: "deny", message: "turn stopped", interrupt: true });
    signal.addEventListener("abort", onAbort);

    const timer = setInterval(async () => {
      try {
        const session = await ctx.client.getSession({ heartbeat: true });
        if (session.answer?.tool_use_id === toolUseId) {
          finish({
            behavior: "allow",
            updatedInput: {
              questions: (input as { questions?: unknown }).questions,
              answers: session.answer.answers,
              response: session.answer.response,
            },
          });
        }
      } catch (e) {
        if (e instanceof SessionEndedError) {
          finish({ behavior: "deny", message: "session ended", interrupt: true });
        }
        // Any other poll failure is ignored, exactly like checkInterrupt: it
        // retries a second later.
      }
    }, INTERRUPT_POLL_INTERVAL_MS);
  });
}

/**
 * Intercepts only `AskUserQuestion`; every other tool keeps the
 * unconditional bypass this connector always runs with (canUseTool is not
 * otherwise consulted under bypassPermissions, so this is a narrow addition,
 * not a new gate).
 */
export function makeCanUseTool(ctx: SessionContext): CanUseTool {
  return async (toolName, input, toolOpts) => {
    if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
    // A Turn stalled here cannot look at a Steer until this resolves --
    // watchForSteers reads this to leave the cursor alone rather than
    // advancing it over a Command nothing will read yet.
    ctx.questionPending = true;
    try {
      return await waitForAnswer(ctx, input, toolOpts.toolUseID, toolOpts.signal);
    } finally {
      ctx.questionPending = false;
    }
  };
}
