import type { Query, SDKMessage, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue } from "../src/sdk/asyncQueue.ts";
import { createSdkMessageMapper } from "../src/sdk/bridge.ts";
import type { CommandRecord, EventInput, RelayClient } from "../src/relay/client.ts";
import type { SessionContext } from "../src/session/context.ts";
import { InFlight, type InFlightDeps } from "../src/session/inFlight.ts";
import type { ConnectorState } from "../src/state.ts";

/** Records what the ledger reported, so a test can assert on transitions rather than only on the final value. */
export class FakeRelay {
  readonly reports: boolean[] = [];
  readonly posted: EventInput[] = [];
  /** Every contribution reported, so a test can assert a Turn reported once, or not at all. */
  readonly contributions: { host?: string; repo?: string; added: number; deleted: number }[] = [];
  /** Set to make the next setInFlight reject, for the best-effort path. */
  failNextReport: Error | undefined;

  async setInFlight(value: boolean): Promise<void> {
    if (this.failNextReport) {
      const e = this.failNextReport;
      this.failNextReport = undefined;
      throw e;
    }
    this.reports.push(value);
  }

  getSession: () => Promise<Awaited<ReturnType<RelayClient["getSession"]>>> = async () => ({});

  async pollCommands(): Promise<CommandRecord[]> {
    return [];
  }

  /** Every Auto-compact submission, so a test can assert it fired (or didn't) without a real relay. */
  readonly postedCommands: string[] = [];
  /** Set to make the next postCommand reject, for the best-effort retry path. */
  failNextPostCommand: Error | undefined;

  async postCommand(text: string): Promise<{ seq: string; created_at: string }> {
    if (this.failNextPostCommand) {
      const e = this.failNextPostCommand;
      this.failNextPostCommand = undefined;
      throw e;
    }
    this.postedCommands.push(text);
    return { seq: `auto-${this.postedCommands.length}`, created_at: new Date().toISOString() };
  }

  async postEvents(events: EventInput[]): Promise<number> {
    this.posted.push(...events);
    return events.length;
  }

  async putSkills(): Promise<void> {}

  async postContribution(input: {
    host?: string;
    repo?: string;
    added: number;
    deleted: number;
  }): Promise<void> {
    this.contributions.push(input);
  }

  get lastReport(): boolean | undefined {
    return this.reports[this.reports.length - 1];
  }

  asClient(): RelayClient {
    return this as unknown as RelayClient;
  }
}

export interface LedgerHarness {
  ledger: InFlight;
  relay: FakeRelay;
  /** Every state patch the ledger asked for, in order. */
  patches: Partial<ConnectorState>[];
  emitted: EventInput[];
}

export function makeLedger(opts: { cursor?: string } = {}): LedgerHarness {
  const relay = new FakeRelay();
  const patches: Partial<ConnectorState>[] = [];
  const emitted: EventInput[] = [];
  const deps: InFlightDeps = {
    setInFlight: (value) => relay.setInFlight(value),
    persist: (patch) => {
      patches.push(patch);
    },
    emit: (event) => {
      emitted.push(event);
    },
  };
  return { ledger: new InFlight(deps, opts), relay, patches, emitted };
}

let nextSeq = 0;

export function cmd(text: string, seq?: string, source?: "phone" | "auto"): CommandRecord {
  nextSeq += 1;
  return {
    seq: seq ?? `c${nextSeq}`,
    text,
    created_at: new Date(Date.now() - 1000).toISOString(),
    ...(source ? { source } : {}),
  };
}

// --- SDK message constructors -------------------------------------------
// Only the fields the connector actually reads. Cast at the edge rather than
// building a whole valid SDKMessage, which would bury what each test is
// varying under a wall of irrelevant structure.

export function init(sessionId = "sdk-1"): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId, skills: [] } as unknown as SDKMessage;
}

export function assistantText(text: string): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

export function result(
  subtype: "success" | "error_during_execution" = "success",
  usage: {
    total_cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } = {},
): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 5,
    total_cost_usd: usage.total_cost_usd ?? 0.001,
    is_error: subtype !== "success",
    result: subtype === "success" ? "done" : "failed",
    usage: {
      input_tokens: usage.input_tokens ?? 100,
      output_tokens: usage.output_tokens ?? 50,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 10,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 5,
    },
  } as unknown as SDKMessage;
}

export function compactBoundary(): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 100 },
  } as unknown as SDKMessage;
}

/**
 * A Query over a fixed message list. `onStreamInput` fires when a Steer is
 * streamed in, which is what lets a test decide -- deterministically, rather
 * than by racing a timer -- whether the SDK ever answers it with a fresh
 * `init`.
 */
export function scriptedQuery(
  messages: SDKMessage[],
  opts: {
    commands?: SlashCommand[];
    onStreamInput?: (text: string, emit: (m: SDKMessage) => void) => void;
    streamInputThrows?: Error;
    /** Runs just before each message reaches the Turn, so a test can act at an exact point in the drain rather than racing a timer. */
    onYield?: (message: SDKMessage) => void | Promise<void>;
    /** Thrown from the drain after `throwAfter` messages, standing in for a subprocess that died mid-Turn. */
    throwAfter?: { count: number; error: Error };
  } = {},
): { query: SessionContext["query"]; streamed: string[] } {
  const streamed: string[] = [];
  const query: SessionContext["query"] = () => {
    const pending = new AsyncQueue<SDKMessage>();
    for (const m of messages) pending.push(m);
    pending.close();

    // Anything the persona injects mid-drain jumps ahead of the remaining
    // scripted messages, matching how a Steer truncates a real Turn.
    const injected: SDKMessage[] = [];
    let delivered = 0;
    const iterator = (async function* () {
      const deliver = async function* (m: SDKMessage) {
        if (opts.throwAfter && delivered >= opts.throwAfter.count) throw opts.throwAfter.error;
        await opts.onYield?.(m);
        delivered += 1;
        yield m;
      };
      for await (const m of pending) {
        while (injected.length) yield* deliver(injected.shift()!);
        yield* deliver(m);
      }
      while (injected.length) yield* deliver(injected.shift()!);
    })();

    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      next: () => iterator.next(),
      return: (value?: void) => iterator.return(value),
      throw: (e?: unknown) => iterator.throw(e),
      supportedCommands: async () => opts.commands ?? [],
      stopTask: async () => undefined,
      streamInput: async (stream: AsyncIterable<SDKUserMessage>) => {
        if (opts.streamInputThrows) throw opts.streamInputThrows;
        for await (const m of stream) {
          const content = (m.message as { content?: unknown }).content;
          const text =
            typeof content === "string"
              ? content
              : ((content as { text?: string }[] | undefined)?.[0]?.text ?? "");
          streamed.push(text);
          opts.onStreamInput?.(text, (msg) => injected.push(msg));
        }
      },
      getContextUsage: async () => ({ percentage: 42 }),
    };
    return q as unknown as Query;
  };
  return { query, streamed };
}

export interface TurnHarness {
  ctx: SessionContext;
  ledger: InFlight;
  relay: FakeRelay;
  written: ConnectorState[];
  streamed: string[];
}

/**
 * A SessionContext wired to fakes, with no relay, no state file and no
 * subprocess. Everything a Turn touches that leaves the process is a field on
 * the context, which is what makes this possible at all.
 */
export function makeTurnHarness(
  messages: SDKMessage[],
  opts: Parameters<typeof scriptedQuery>[1] & {
    /** A real directory for the Turn to run in -- only tests of git-derived behaviour need one. */
    projectDir?: string;
    /** Overrides merged into the fake config -- e.g. `inactivityCompact` for Auto-compact tests. */
    config?: Partial<SessionContext["config"]>;
  } = {},
): TurnHarness {
  const relay = new FakeRelay();
  const written: ConnectorState[] = [];
  const { query, streamed } = scriptedQuery(messages, opts);

  let ctx: SessionContext;
  const ledger = new InFlight({
    setInFlight: (value) => relay.setInFlight(value),
    persist: (patch) => {
      ctx.state = { ...ctx.state, ...patch };
      written.push(ctx.state);
    },
    emit: (event) => {
      ctx.eventBuffer.push(event);
    },
  });

  ctx = {
    client: relay.asClient(),
    config: {
      relayBaseUrl: "http://relay.test",
      createSecret: "s",
      projectDir: opts.projectDir ?? "/tmp/project",
      provider: { type: "anthropic" },
      ...opts.config,
    } as SessionContext["config"],
    providerEnv: {},
    query,
    writeState: (state) => {
      written.push(state);
    },
    inFlight: ledger,
    mapMessage: createSdkMessageMapper(),
    state: {
      version: 1,
      projectDir: "/tmp/project",
      relayBaseUrl: "http://relay.test",
      sessionId: "sess",
      secret: "sec",
      phoneUrl: "http://relay.test/?s=sess",
      pid: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    lastSkillsJson: undefined,
    sdkSessionId: undefined,
    eventBuffer: [],
    running: true,
    sessionEnded: false,
    runningTasks: [],
    lastHandledKillAt: undefined,
    handBackBuffer: [],
    questionPending: false,
    currentTurn: undefined,
    currentQuery: undefined,
    flushChain: Promise.resolve(),
  };

  return { ctx, ledger, relay, written, streamed };
}
