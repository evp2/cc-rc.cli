import { SessionEndedError, type EventInput, type SkillInfo } from "../relay/client";
import type { ConnectorState } from "../state";
import type { SessionContext } from "./context";

/** Best-effort: a state write failure costs resume on the next start, but the session in progress is still perfectly usable -- don't take it down for this. */
export function persist(ctx: SessionContext, patch: Partial<ConnectorState>): void {
  ctx.state = { ...ctx.state, ...patch };
  try {
    ctx.writeState(ctx.state);
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
    await ctx.client.putSkills(skills, localCommands, ctx.config.inactivityCompact?.afterMinutes);
    ctx.lastSkillsJson = asJson;
  } catch (e) {
    if (e instanceof SessionEndedError) return;
    console.error("Failed to publish skills:", (e as Error).message);
  }
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
