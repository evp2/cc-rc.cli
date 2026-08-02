import { SessionEndedError } from "../relay/client";
import type { SessionContext } from "./context";

// The relay rejects any batch larger than this, so flushes must be chunked --
// a busy turn can easily buffer more than this in one flush interval.
const MAX_EVENTS_PER_BATCH = 25;
// Ceiling on retained events when the relay is failing, so a prolonged outage
// can't grow the buffer without bound.
const MAX_BUFFERED_EVENTS = 1000;

/**
 * Posts the buffer in relay-sized chunks, oldest first. Events are only
 * removed from the buffer once the relay has accepted them: dropping a failed
 * batch can lose the `turn_complete` that re-enables the phone's composer,
 * which strands the UI mid-turn with no error shown.
 */
async function doFlush(ctx: SessionContext): Promise<void> {
  while (ctx.eventBuffer.length > 0 && !ctx.sessionEnded) {
    const batch = ctx.eventBuffer.slice(0, MAX_EVENTS_PER_BATCH);
    try {
      await ctx.client.postEvents(batch);
      ctx.eventBuffer = ctx.eventBuffer.slice(batch.length);
    } catch (e) {
      if (e instanceof SessionEndedError) {
        ctx.sessionEnded = true;
        ctx.running = false;
        ctx.eventBuffer = [];
        return;
      }
      console.error("Failed to flush events, will retry:", (e as Error).message);
      if (ctx.eventBuffer.length > MAX_BUFFERED_EVENTS) {
        const dropped = ctx.eventBuffer.length - MAX_BUFFERED_EVENTS;
        console.error(`Event buffer full, dropping ${dropped} oldest events.`);
        ctx.eventBuffer = ctx.eventBuffer.slice(dropped);
      }
      return;
    }
  }
}

/** Serialises flushes so event order stays stable when a flush outlives its interval tick, and so shutdown can await every queued flush. */
export function flushEvents(ctx: SessionContext): Promise<void> {
  ctx.flushChain = ctx.flushChain.then(() => doFlush(ctx), () => undefined);
  return ctx.flushChain;
}
