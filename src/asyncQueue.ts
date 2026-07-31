import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Minimal pull-based async queue: a value pushed before anyone is waiting is
 * buffered; a `next()` call arriving before any value exists parks until one
 * is pushed. Backs both sides of the streaming-input seam -- a Turn's prompt
 * in run.ts (real SDK) and the fake SDK's per-Turn mailbox of injected input
 * (fakeSdk.ts) share this same shape.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly parked: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  /** No-op once closed, so a late push can never resurrect a stream a reader has already been told is done. */
  push(value: T): void {
    if (this.closed) return;
    const resolve = this.parked.shift();
    if (resolve) resolve({ value, done: false });
    else this.buffered.push(value);
  }

  /** Ends the stream. Idempotent; resolves every parked `next()` as done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.parked.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as T, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.parked.push(resolve));
      },
    };
  }
}

/**
 * Reads exactly one value off an async iterable, or undefined if it ends
 * before producing one. Leaves the rest of the iterable untouched -- callers
 * that never invoke this at all (an un-iterated generator) never run any of
 * its body, which is what lets a probe query's never-yielding prompt pass
 * through here safely as long as nothing actually calls it.
 */
export async function takeOne<T>(source: AsyncIterable<T>): Promise<T | undefined> {
  const { value, done } = await source[Symbol.asyncIterator]().next();
  return done ? undefined : value;
}

/**
 * Builds the plain-text user message shape the connector streams, both as a
 * Turn's initial prompt and as a Steer delivered via `streamInput`.
 *
 * `priority: 'now'` is what the measured SDK contract requires for a message
 * streamed into a Turn already running to truncate it rather than queue
 * behind whatever it was doing -- omitted for the initial prompt, where it
 * has no running Turn to truncate and no effect either way.
 */
export function userTextMessage(text: string, opts: { priority?: "now" } = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...opts,
  } as SDKUserMessage;
}

/** The text of a user message built by {@link userTextMessage}, or any plain-string-content SDKUserMessage. */
export function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}
