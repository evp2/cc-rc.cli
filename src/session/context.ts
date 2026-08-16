import type { query as realQuery, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ConnectorConfig } from "../config";
import type { createSdkMessageMapper } from "../sdk/bridge";
import type { CommandRecord, EventInput, RelayClient } from "../relay/client";
import type { InFlight } from "./inFlight";
import type { ConnectorState } from "../state";

/**
 * The Turn currently executing, if any -- shared between {@link runTurn} in
 * turn.ts and {@link watchForSteers} in watchers.ts.
 *
 * Carries only what is not a claim. Which Commands the Turn holds, and which
 * of them a Steer is waiting on, live on the handle {@link InFlight.current}
 * returns: they used to be duplicated here and in the held set, and the two
 * copies drifting is what left a Steer claimed forever.
 */
export interface CurrentTurn {
  abortController: AbortController;
  /** Whether this specific sub-turn has already taken its one allowed Steer. */
  steeredThisSubTurn: boolean;
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

  /**
   * The connector's door into the SDK's `query()`, defaulted from sdk/client.ts
   * so production and the e2e harness are unaffected. A field rather than a
   * direct import because that module picks its adapter once, from a process
   * environment variable -- a real seam, but one placed at process scope, which
   * is why driving a Turn used to require a whole connector process. Passed
   * here, a test can hand a Turn a scripted message sequence in-process.
   */
  readonly query: typeof realQuery;

  /** How durable state reaches disk. A field for the same reason `query` is: the real one resolves a path under the user's home directory, which a test must not write to. */
  readonly writeState: (state: ConnectorState) => void;

  /** The authoritative record of every Command held but not finished, and the command-log cursor that moves with it. */
  readonly inFlight: InFlight;

  state: ConnectorState;
  /** Last-published skill+local-command lists, as JSON, so a turn whose lists haven't changed since the last publish (the common case) doesn't PUT anything. */
  lastSkillsJson: string | undefined;
  sdkSessionId: string | undefined;
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
   * Whether a Context-window warning has already fired for the current
   * threshold crossing (see CONTEXT.md) -- the edge-trigger's own arm/suppress
   * flag. Set once `context_percentage` crosses the configured threshold, and
   * cleared the moment it drops back below, so the warning fires once per
   * crossing rather than on every subsequent Turn. In-memory only, unlike
   * Auto-compact's equivalent: nothing is lost by re-arming on restart, since
   * a fresh process has no better guess than reading the next real percentage.
   */
  contextWarningActive: boolean;

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
        getContextUsage(): Promise<{ percentage: number }>;
      }
    | undefined;

  /** Serialising flushes keeps event order stable when a flush outlives its interval tick, and lets shutdown await every queued flush. */
  flushChain: Promise<void>;
}
