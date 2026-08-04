import { SessionEndedError, type CommandRecord, type EventInput, type SkillInfo } from "../relay/client";
import { writeState, type ConnectorState } from "../state";
import type { SessionContext } from "./context";

/** Best-effort: a state write failure costs resume on the next start, but the session in progress is still perfectly usable -- don't take it down for this. */
export function persist(ctx: SessionContext, patch: Partial<ConnectorState>): void {
  ctx.state = { ...ctx.state, ...patch };
  try {
    writeState(ctx.state);
  } catch (e) {
    console.error("Failed to write connector state:", (e as Error).message);
  }
}

/** Best-effort: a failed publish leaves the phone's menu stale, not broken. */
export async function publishSkills(
  ctx: SessionContext,
  skills: SkillInfo[],
  localCommands: SkillInfo[],
): Promise<void> {
  const asJson = JSON.stringify([skills, localCommands]);
  if (asJson === ctx.lastSkillsJson) return;
  try {
    await ctx.client.putSkills(skills, localCommands);
    ctx.lastSkillsJson = asJson;
  } catch (e) {
    if (e instanceof SessionEndedError) return;
    console.error("Failed to publish skills:", (e as Error).message);
  }
}

function inFlightSnapshot(ctx: SessionContext): ConnectorState["inFlight"] {
  return ctx.inFlightEntries.size ? [...ctx.inFlightEntries.values()] : undefined;
}

/** Best-effort: a failed report leaves the phone's brake stale until the next successful one, not broken. */
export async function reportInFlight(ctx: SessionContext, inFlight: boolean): Promise<void> {
  try {
    await ctx.client.setInFlight(inFlight);
  } catch (e) {
    if (e instanceof SessionEndedError) return;
    console.error("Failed to report in-flight state:", (e as Error).message);
  }
}

/**
 * Claims a Command freshly read off the relay: advances the shared cursor
 * and adds it to the in-flight set. Reports in-flight to the relay exactly
 * once, on the transition from holding nothing to holding something, so a
 * run of queued work reads as continuous rather than flickering.
 */
export async function claim(
  ctx: SessionContext,
  command: CommandRecord,
  status: "running" | "queued",
): Promise<void> {
  const wasEmpty = ctx.inFlightEntries.size === 0;
  ctx.inFlightEntries.set(command.seq, { seq: command.seq, text: command.text, status });
  ctx.since = command.seq;
  persist(ctx, { commandCursor: command.seq, inFlight: inFlightSnapshot(ctx) });
  if (wasEmpty) await reportInFlight(ctx, true);
}

/** Moves an already-claimed Command to `running` -- no cursor movement, since claiming it already advanced the cursor. */
export function promoteToRunning(ctx: SessionContext, seq: string): void {
  const entry = ctx.inFlightEntries.get(seq);
  if (!entry) return;
  entry.status = "running";
  persist(ctx, { inFlight: inFlightSnapshot(ctx) });
}

/** A Command's Turn has ended (or it was discarded). Reports in-flight false exactly on the transition to holding nothing. */
export async function release(ctx: SessionContext, seq: string): Promise<void> {
  if (!ctx.inFlightEntries.delete(seq)) return;
  persist(ctx, { inFlight: inFlightSnapshot(ctx) });
  if (ctx.inFlightEntries.size === 0) await reportInFlight(ctx, false);
}

/**
 * Reported the moment it happens, not at a later restart -- a brake that
 * starts fresh work is not a brake, and no restart is coming to explain a
 * sentence that just vanished while the human was watching the screen.
 */
export async function discard(ctx: SessionContext, seq: string): Promise<void> {
  const entry = ctx.inFlightEntries.get(seq);
  ctx.eventBuffer.push({
    type: "error",
    text: entry
      ? `Discarded by Stop before it ran: ${entry.text}`
      : "Discarded by Stop before it ran.",
    is_error: true,
  });
  await release(ctx, seq);
}

/**
 * Keeps {@link SessionContext.runningTasks} (and the state file) in step
 * with the background-task events just produced, so restart-honesty has an
 * accurate set to report. Only non-ambient tasks are tracked: they are the
 * ones with an inline card that would otherwise strand.
 */
export function trackBackgroundTasks(ctx: SessionContext, events: EventInput[]): void {
  let changed = false;
  for (const e of events) {
    if (e.type === "background_task_started" && e.task_id && !e.is_ambient) {
      if (!ctx.runningTasks.some((t) => t.task_id === e.task_id)) {
        ctx.runningTasks.push({ task_id: e.task_id, tool_use_id: e.tool_use_id, description: e.text });
        changed = true;
      }
    } else if (e.type === "background_task_settled" && e.task_id) {
      const filtered = ctx.runningTasks.filter((t) => t.task_id !== e.task_id);
      if (filtered.length !== ctx.runningTasks.length) {
        ctx.runningTasks = filtered;
        changed = true;
      }
    }
  }
  if (changed) {
    persist(ctx, { runningTasks: ctx.runningTasks.length ? [...ctx.runningTasks] : undefined });
  }
}
