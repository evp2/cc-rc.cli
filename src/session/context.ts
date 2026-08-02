import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ConnectorConfig } from "../config";
import type { createSdkMessageMapper } from "../sdk/bridge";
import type { CommandRecord, EventInput, RelayClient } from "../relay/client";
import type { ConnectorState } from "../state";

/** The Turn currently executing, if any -- shared between {@link runTurn} in turn.ts and {@link watchForSteers} in watchers.ts. */
export interface CurrentTurn {
  abortController: AbortController;
  /** The Command whose entry in {@link SessionContext.inFlightEntries} is `running` right now. */
  activeSeq: string;
  /** Whether this specific sub-turn has already taken its one allowed Steer. */
  steeredThisSubTurn: boolean;
  /** Set the instant a Steer is streamed in, cleared once its fresh `system:init` confirms it landed. */
  pendingSteerSeq?: string;
}

/**
 * The mutable state shared by every module under `session/`, plus the
 * connection's fixed dependencies. One instance per `runConnector` call,
 * built in loop.ts and threaded through commands.ts/events.ts/watchers.ts/
 * turn.ts explicitly instead of via closures, since those modules each own a
 * different slice of the same session lifecycle.
 */
export interface SessionContext {
  readonly client: RelayClient;
  readonly config: ConnectorConfig;
  readonly providerEnv: NodeJS.ProcessEnv;
  readonly mapMessage: ReturnType<typeof createSdkMessageMapper>;

  state: ConnectorState;
  /** Last-published skill+local-command lists, as JSON, so a turn whose lists haven't changed since the last publish (the common case) doesn't PUT anything. */
  lastSkillsJson: string | undefined;
  sdkSessionId: string | undefined;
  /**
   * The shared command-log cursor: the main loop's own poll and the
   * turn-scoped {@link watchForSteers} poll both read and advance this same
   * field, since claiming a Command -- whichever of the two claims it --
   * must never be re-read by the other.
   */
  since: string | undefined;
  eventBuffer: EventInput[];
  running: boolean;
  /** Set once the relay reports the session gone; suppresses further posting. */
  sessionEnded: boolean;
  /**
   * Background tasks currently believed to be running, mirrored into the
   * state file so a restart can report each as `interrupted` rather than
   * leaving the phone's inline card spinning.
   */
  runningTasks: NonNullable<ConnectorState["runningTasks"]>;
  /**
   * The `requested_at` of the most recent Kill already actioned, so the same
   * request isn't re-sent to the SDK on every poll.
   */
  lastHandledKillAt: string | undefined;

  /**
   * Every Command the connector currently holds but has not finished, keyed
   * by seq -- the source of both the relay-facing in-flight fact and the
   * state file's crash-honesty record.
   */
  readonly inFlightEntries: Map<string, { seq: string; text: string; status: "running" | "queued" }>;

  /**
   * In-memory only, by design: a Command the current Turn was too late to
   * accept (or found alongside the one Steer it already took) goes back to
   * the main loop here and runs as an ordinary Turn before the next relay
   * poll -- not rewound, not re-fetched.
   */
  readonly handBackBuffer: CommandRecord[];

  /**
   * Set while a `canUseTool` call is holding a Turn open on a pending
   * Question, so {@link watchForSteers} knows not to advance the cursor over
   * a Command the stalled Turn cannot read yet.
   */
  questionPending: boolean;

  currentTurn: CurrentTurn | undefined;

  /**
   * The most recently created turn's Query, for as long as its own generator
   * is still being drained. Live for the persistent kill-watcher to act
   * against for as long as a turn's subprocess is -- which can outlast the
   * turn's own `result` while one of its Background tasks is still running.
   */
  currentQuery:
    | {
        stopTask(taskId: string): Promise<void>;
        streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
      }
    | undefined;

  /** Serialising flushes keeps event order stable when a flush outlives its interval tick, and lets shutdown await every queued flush. */
  flushChain: Promise<void>;
}
