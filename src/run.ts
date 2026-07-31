import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue, userTextMessage } from "./asyncQueue";
import { PERMISSION_MODE, type ConnectorConfig } from "./config";
import { buildProviderEnv } from "./provider";
import { query } from "./sdkClient";
import { createSdkMessageMapper } from "./sdkBridge";
import {
  RelayClient,
  SessionEndedError,
  type CommandRecord,
  type EventInput,
  type SkillInfo,
} from "./relayClient";
import { probeSkills, selectLocalCommands, selectSkills } from "./skills";
import { readState, writeState, type ConnectorState } from "./state";

const POLL_INTERVAL_MS = 1750;
const FLUSH_INTERVAL_MS = 750;
// How often a running turn checks whether the phone has asked it to stop.
// Bounds how long "Stop" takes to visibly do something.
const INTERRUPT_POLL_INTERVAL_MS = 1000;
// The relay rejects any batch larger than this, so flushes must be chunked --
// a busy turn can easily buffer more than this in one flush interval.
const MAX_EVENTS_PER_BATCH = 25;
// Ceiling on retained events when the relay is failing, so a prolonged outage
// can't grow the buffer without bound.
const MAX_BUFFERED_EVENTS = 1000;

export interface RunHandle {
  phoneUrl: string;
  sessionId: string;
  /** False when the session was newly minted, so callers can say which it was. */
  resumed: boolean;
  /** Resolves when the session loop has stopped and its last flush completed. */
  done: Promise<void>;
}

/**
 * Acquires a session for this project directory, preferring to resume the one
 * in the state file over minting a new one, so an ordinary restart costs the
 * phone no re-pairing.
 *
 * State belonging to a different relay or project directory is ignored rather
 * than trusted -- a config edit should not silently reattach the connector to a
 * session created under the old settings.
 */
async function acquireSession(
  config: ConnectorConfig,
): Promise<{ client: RelayClient; phoneUrl: string; resumed: ConnectorState | undefined }> {
  const previous = readState(config.projectDir);
  const reusable =
    previous &&
    previous.relayBaseUrl === config.relayBaseUrl &&
    previous.projectDir === config.projectDir;

  if (reusable) {
    try {
      const client = await RelayClient.resume(
        config.relayBaseUrl,
        previous.sessionId,
        previous.secret,
      );
      console.log(`Resumed session ${client.sessionId}`);
      return { client, phoneUrl: previous.phoneUrl || client.phoneUrl(), resumed: previous };
    } catch (e) {
      if (!(e instanceof SessionEndedError)) throw e;
      console.log("Previous session has ended; starting a new one.");
    }
  }

  const { client, phoneUrl } = await RelayClient.create(
    config.relayBaseUrl,
    config.createSecret,
    {
      permissionMode: PERMISSION_MODE,
      providerType: config.provider.type,
      providerModel: config.provider.type === "bedrock" ? config.provider.model : undefined,
      providerRegion: config.provider.type === "bedrock" ? config.provider.region : undefined,
      projectDir: config.projectDir,
    },
  );
  // Rotating discards the conversation along with the session, so a blank
  // transcript on the phone always means a genuinely fresh Claude.
  return { client, phoneUrl, resumed: undefined };
}

/**
 * Runs the session loop in the foreground until stopped. Returns once the
 * session is live, so a caller can report the phone URL before the loop ends.
 */
export async function runConnector(config: ConnectorConfig): Promise<RunHandle> {
  const providerEnv = buildProviderEnv(config.provider);
  const { client, phoneUrl, resumed } = await acquireSession(config);
  // One mapper for the whole process: it remembers the session banner across
  // turns so it is announced once, not above every reply.
  const mapMessage = createSdkMessageMapper();

  let state: ConnectorState = {
    version: 1,
    projectDir: config.projectDir,
    relayBaseUrl: config.relayBaseUrl,
    sessionId: client.sessionId,
    secret: client.sessionSecret,
    phoneUrl,
    commandCursor: resumed?.commandCursor,
    sdkSessionId: resumed?.sdkSessionId,
    inFlight: undefined,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function persist(patch: Partial<ConnectorState>): void {
    state = { ...state, ...patch };
    try {
      writeState(state);
    } catch (e) {
      // A state write failure costs resume on the next start, but the session
      // in progress is still perfectly usable -- don't take it down for this.
      console.error("Failed to write connector state:", (e as Error).message);
    }
  }

  persist({});

  // Last-published skill+local-command lists, as JSON, so a turn whose lists
  // haven't changed since the last publish (the common case) doesn't PUT
  // anything.
  let lastSkillsJson: string | undefined;

  /** Best-effort: a failed publish leaves the phone's menu stale, not broken. */
  async function publishSkills(skills: SkillInfo[], localCommands: SkillInfo[]): Promise<void> {
    const asJson = JSON.stringify([skills, localCommands]);
    if (asJson === lastSkillsJson) return;
    try {
      await client.putSkills(skills, localCommands);
      lastSkillsJson = asJson;
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      console.error("Failed to publish skills:", (e as Error).message);
    }
  }

  // Populates the phone's menu before the first turn ever runs. Spawns a
  // throwaway query() purely to read the skill list -- see probeSkills for why
  // this costs no model spend. Not awaited: the phone URL should be handed
  // back immediately, and an empty menu for the few hundred ms this takes is
  // harmless.
  void (async () => {
    try {
      const { skills, localCommands } = await probeSkills(config.projectDir, providerEnv);
      await publishSkills(skills, localCommands);
    } catch (e) {
      console.error("Failed to probe skills at startup:", (e as Error).message);
    }
  })();

  let sdkSessionId = state.sdkSessionId;
  // The shared command-log cursor: the main loop's own poll and the
  // turn-scoped {@link watchForSteers} poll both read and advance this same
  // variable, since claiming a Command -- whichever of the two claims it --
  // must never be re-read by the other.
  let since = state.commandCursor;
  let eventBuffer: EventInput[] = [];
  let running = true;
  // Set once the relay reports the session gone; suppresses further posting.
  let sessionEnded = false;
  // Background tasks currently believed to be running, mirrored into the state
  // file so a restart can report each as `interrupted` rather than leaving the
  // phone's inline card spinning. Rebuilt from the events the connector itself
  // emits: a non-ambient started adds, its settled removes.
  let runningTasks: NonNullable<ConnectorState["runningTasks"]> = [];
  // The `requested_at` of the most recent Kill already actioned, so the same
  // request isn't re-sent to the SDK on every poll. Per-process: a stale Kill
  // left in the session from before a restart targets a task that died with the
  // old process, and re-actioning it is a harmless no-op anyway.
  let lastHandledKillAt: string | undefined;

  // Every Command recorded as in flight by a previous process never
  // completed -- the connector died holding it. Cursors for all of them were
  // already advanced, so none will be re-run; say so rather than letting them
  // vanish silently. A `running` entry was genuinely cut off mid-turn; a
  // `queued` one (a Steer that had been claimed, or hand-back work) never
  // started at all, so calling it "interrupted" would say something false.
  if (resumed?.inFlight?.length) {
    for (const entry of resumed.inFlight) {
      console.log(`Reporting ${entry.status} command dropped by restart: ${entry.seq}`);
      eventBuffer.push({
        type: "error",
        text:
          entry.status === "running"
            ? "The previous turn was interrupted when the connector stopped, and will " +
              "not be re-run automatically. Send it again if you still want it."
            : "A queued command was dropped when the connector stopped before it ran. " +
              "Send it again if you still want it.",
        is_error: true,
      });
    }
    persist({ inFlight: undefined });
  }

  // Background tasks left running when a previous process died are gone with it
  // -- the CLI subprocess they were children of no longer exists. Report each
  // as interrupted and empty the tray, so nothing sits spinning forever.
  // Mirrors the in-flight-turn honesty above.
  if (resumed?.runningTasks?.length) {
    console.log(
      `Reporting ${resumed.runningTasks.length} background task(s) interrupted by restart.`,
    );
    for (const t of resumed.runningTasks) {
      eventBuffer.push({
        type: "background_task_settled",
        task_id: t.task_id,
        tool_use_id: t.tool_use_id,
        task_status: "interrupted",
        text: t.description
          ? `interrupted by connector restart: ${t.description}`
          : "interrupted by connector restart",
      });
    }
    // The live set is per-process and empty after a restart; say so, so a
    // reload's replay of the last non-empty set doesn't show stale running work.
    eventBuffer.push({ type: "background_tasks_changed", tasks: [] });
    persist({ runningTasks: undefined });
  }

  // Every Command the connector currently holds but has not finished, keyed
  // by seq -- the source of both the relay-facing in-flight fact and the
  // state file's crash-honesty record. `claim` adds an entry and advances the
  // cursor for a Command freshly read off the relay; `promoteToRunning` and
  // `release` move an already-claimed entry between the two without touching
  // the cursor again.
  const inFlightEntries = new Map<
    string,
    { seq: string; text: string; status: "running" | "queued" }
  >();

  function inFlightSnapshot(): ConnectorState["inFlight"] {
    return inFlightEntries.size ? [...inFlightEntries.values()] : undefined;
  }

  /** Best-effort: a failed report leaves the phone's brake stale until the next successful one, not broken. */
  async function reportInFlight(inFlight: boolean): Promise<void> {
    try {
      await client.setInFlight(inFlight);
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
  async function claim(command: CommandRecord, status: "running" | "queued"): Promise<void> {
    const wasEmpty = inFlightEntries.size === 0;
    inFlightEntries.set(command.seq, { seq: command.seq, text: command.text, status });
    since = command.seq;
    persist({ commandCursor: command.seq, inFlight: inFlightSnapshot() });
    if (wasEmpty) await reportInFlight(true);
  }

  /** Moves an already-claimed Command to `running` -- no cursor movement, since claiming it already advanced the cursor. */
  function promoteToRunning(seq: string): void {
    const entry = inFlightEntries.get(seq);
    if (!entry) return;
    entry.status = "running";
    persist({ inFlight: inFlightSnapshot() });
  }

  /** A Command's Turn has ended (or it was discarded). Reports in-flight false exactly on the transition to holding nothing. */
  async function release(seq: string): Promise<void> {
    if (!inFlightEntries.delete(seq)) return;
    persist({ inFlight: inFlightSnapshot() });
    if (inFlightEntries.size === 0) await reportInFlight(false);
  }

  /**
   * Reported the moment it happens, not at a later restart -- a brake that
   * starts fresh work is not a brake, and no restart is coming to explain a
   * sentence that just vanished while the human was watching the screen.
   */
  async function discard(seq: string): Promise<void> {
    const entry = inFlightEntries.get(seq);
    eventBuffer.push({
      type: "error",
      text: entry
        ? `Discarded by Stop before it ran: ${entry.text}`
        : "Discarded by Stop before it ran.",
      is_error: true,
    });
    await release(seq);
  }

  // In-memory only, by design: a Command the current Turn was too late to
  // accept (or found alongside the one Steer it already took) goes back to
  // the main loop here and runs as an ordinary Turn before the next relay
  // poll -- not rewound, not re-fetched. An evicted process loses whatever is
  // queued here, the same class of loss a laptop crash already reports via
  // `inFlight`'s `queued` entries above.
  const handBackBuffer: CommandRecord[] = [];

  // Set while a `canUseTool` call is holding a Turn open on a pending
  // Question, so {@link watchForSteers} knows not to advance the cursor over
  // a Command the stalled Turn cannot read yet.
  let questionPending = false;

  /** The Turn currently executing, if any -- shared between {@link runTurn} and {@link watchForSteers}. */
  interface CurrentTurn {
    abortController: AbortController;
    /** The Command whose entry in {@link inFlightEntries} is `running` right now. */
    activeSeq: string;
    /** Whether this specific sub-turn has already taken its one allowed Steer. */
    steeredThisSubTurn: boolean;
    /** Set the instant a Steer is streamed in, cleared once its fresh `system:init` confirms it landed. */
    pendingSteerSeq?: string;
  }
  let currentTurn: CurrentTurn | undefined;

  /**
   * Keeps {@link runningTasks} (and the state file) in step with the
   * background-task events just produced, so restart-honesty above has an
   * accurate set to report. Only non-ambient tasks are tracked: they are the
   * ones with an inline card that would otherwise strand.
   */
  function trackBackgroundTasks(events: EventInput[]): void {
    let changed = false;
    for (const e of events) {
      if (e.type === "background_task_started" && e.task_id && !e.is_ambient) {
        if (!runningTasks.some((t) => t.task_id === e.task_id)) {
          runningTasks.push({ task_id: e.task_id, tool_use_id: e.tool_use_id, description: e.text });
          changed = true;
        }
      } else if (e.type === "background_task_settled" && e.task_id) {
        const filtered = runningTasks.filter((t) => t.task_id !== e.task_id);
        if (filtered.length !== runningTasks.length) {
          runningTasks = filtered;
          changed = true;
        }
      }
    }
    if (changed) persist({ runningTasks: runningTasks.length ? [...runningTasks] : undefined });
  }

  // The most recently created turn's Query, for as long as its own generator
  // is still being drained -- which, per the SDK, lasts as long as that turn's
  // CLI subprocess does, which is not necessarily only for the turn's visible
  // duration on the phone (a Background task can keep the subprocess alive
  // after its turn's `result` already streamed). Set at the start of a turn,
  // cleared once that turn's draining loop exits. A Kill polled while this is
  // unset genuinely has nothing live to act on -- the subprocess that would
  // have owned the task is gone -- and is retried every tick until either a
  // new turn supplies one or the connector shuts down.
  let currentQuery:
    | {
        stopTask(taskId: string): Promise<void>;
        streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
      }
    | undefined;

  /**
   * Actions a phone's Kill against whichever Query is currently live, running
   * for the connector's whole lifetime rather than scoped to one turn --
   * unlike {@link watchForInterrupt}, which only needs to watch while its own
   * turn is running, a Background task can outlive the turn that spawned it,
   * so Kill must stay actionable between turns too. Idempotent: `stopTask` on
   * an already-settled or unknown task is a no-op.
   */
  function watchForKills(): () => void {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const session = await client.getSession({ heartbeat: true });
          const kill = session.kill_task;
          if (kill && kill.requested_at !== lastHandledKillAt && currentQuery) {
            lastHandledKillAt = kill.requested_at;
            console.log(`Kill requested for background task ${kill.task_id}.`);
            await currentQuery.stopTask(kill.task_id);
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
   * `currentTurn` is unset, which is most of the time between Turns. Sharing
   * one persistent timer is simpler than starting and stopping a fresh one
   * per Turn, and correctness comes from the `currentTurn`/`questionPending`
   * checks below, not from when the timer itself runs.
   *
   * Finds at most one Command to Steer with per tick, and only when this
   * sub-turn hasn't already taken one. Everything else the poll returns --
   * later Commands in the same batch, or any Command once the one Steer is
   * spent -- goes to the hand-back buffer and runs in order as ordinary Turns
   * once the current one ends.
   */
  function watchForSteers(): () => void {
    const timer = setInterval(() => {
      void (async () => {
        const turn = currentTurn;
        if (!turn || !currentQuery) return;
        if (turn.abortController.signal.aborted) return;
        if (questionPending) return;

        let commands: CommandRecord[];
        try {
          commands = await client.pollCommands(since);
        } catch (e) {
          if (!(e instanceof SessionEndedError)) {
            console.error("Steer poll failed:", (e as Error).message);
          }
          return;
        }
        if (commands.length === 0) return;
        // Stop or a Question can have landed while that poll was in flight --
        // re-check against the same turn this tick started for, not fresh
        // globals, so a stale response from a query started under a Turn that
        // has since ended can never mis-claim anything.
        if (currentTurn !== turn || turn.abortController.signal.aborted || questionPending) {
          return;
        }

        const [first, ...rest] = commands;
        if (!turn.steeredThisSubTurn) {
          turn.steeredThisSubTurn = true;
          turn.pendingSteerSeq = first.seq;
          await claim(first, "queued");
          if (turn.abortController.signal.aborted) {
            // Stop landed in the gap between claiming and streaming it in --
            // discard rather than deliver into a query that is already ending.
            turn.pendingSteerSeq = undefined;
            await discard(first.seq);
          } else {
            const steerInput = new AsyncQueue<SDKUserMessage>();
            steerInput.push(userTextMessage(first.text, { priority: "now" }));
            steerInput.close();
            try {
              await currentQuery.streamInput(steerInput);
            } catch (e) {
              console.error("Failed to stream a Steer into the turn:", (e as Error).message);
            }
          }
        } else {
          await claim(first, "queued");
          handBackBuffer.push(first);
        }
        for (const extra of rest) {
          await claim(extra, "queued");
          handBackBuffer.push(extra);
        }
      })();
    }, INTERRUPT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  const flushTimer = setInterval(() => {
    void flushEvents();
  }, FLUSH_INTERVAL_MS);
  const stopWatchingKills = watchForKills();
  const stopWatchingSteers = watchForSteers();

  /**
   * Posts the buffer in relay-sized chunks, oldest first. Events are only
   * removed from the buffer once the relay has accepted them: dropping a failed
   * batch can lose the `turn_complete` that re-enables the phone's composer,
   * which strands the UI mid-turn with no error shown.
   */
  async function doFlush(): Promise<void> {
    while (eventBuffer.length > 0 && !sessionEnded) {
      const batch = eventBuffer.slice(0, MAX_EVENTS_PER_BATCH);
      try {
        await client.postEvents(batch);
        eventBuffer = eventBuffer.slice(batch.length);
      } catch (e) {
        if (e instanceof SessionEndedError) {
          sessionEnded = true;
          running = false;
          eventBuffer = [];
          return;
        }
        console.error("Failed to flush events, will retry:", (e as Error).message);
        if (eventBuffer.length > MAX_BUFFERED_EVENTS) {
          const dropped = eventBuffer.length - MAX_BUFFERED_EVENTS;
          console.error(`Event buffer full, dropping ${dropped} oldest events.`);
          eventBuffer = eventBuffer.slice(dropped);
        }
        return;
      }
    }
  }

  // Serialising flushes keeps event order stable when a flush outlives its
  // interval tick, and lets shutdown await every queued flush.
  let flushChain: Promise<void> = Promise.resolve();
  function flushEvents(): Promise<void> {
    flushChain = flushChain.then(doFlush, () => undefined);
    return flushChain;
  }

  /**
   * Aborts `controller` if the phone has asked to stop since `sinceMs`.
   *
   * Only a request newer than `sinceMs` counts, so a stop aimed at an earlier
   * turn -- or one that lands just as a turn finishes -- can never kill the
   * next one. Poll failures are ignored: the watcher retries a second later,
   * and a genuinely dead relay is the main loop's problem.
   */
  async function checkInterrupt(
    controller: AbortController,
    sinceMs: number,
  ): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      // Doubles as the connector's liveness heartbeat: during a turn this is
      // the only relay traffic, since events flush only when there are events.
      const session = await client.getSession({ heartbeat: true });
      const at = session.interrupt_at ? Date.parse(session.interrupt_at) : 0;
      if (at > sinceMs) {
        console.log("Stop requested from the phone, aborting the current turn.");
        controller.abort();
      }
    } catch (e) {
      if (e instanceof SessionEndedError) controller.abort();
    }
  }

  function watchForInterrupt(controller: AbortController, sinceMs: number): () => void {
    const timer = setInterval(() => {
      void checkInterrupt(controller, sinceMs);
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
          const session = await client.getSession({ heartbeat: true });
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
  const canUseTool: CanUseTool = async (toolName, input, toolOpts) => {
    if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
    // A Turn stalled here cannot look at a Steer until this resolves --
    // watchForSteers reads this to leave the cursor alone rather than
    // advancing it over a Command nothing will read yet.
    questionPending = true;
    try {
      return await waitForAnswer(input, toolOpts.toolUseID, toolOpts.signal);
    } finally {
      questionPending = false;
    }
  };

  /**
   * Runs a Turn to completion -- which, once a Steer lands, is really a chain
   * of Turns inside one query: this keeps draining the same generator across
   * the seam, promoting whichever Command the SDK's fresh `system:init`
   * confirms it moved on to, until a sub-turn ends having taken no further
   * Steer.
   */
  async function runTurn(command: CommandRecord): Promise<void> {
    const text = command.text;
    const abortController = new AbortController();
    currentTurn = { abortController, activeSeq: command.seq, steeredThisSubTurn: false };
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
      cwd: config.projectDir,
      env: providerEnv,
      abortController,
      canUseTool,
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    };

    // A stop counts if it was issued after the command it targets -- not after
    // the turn started. Turns run one at a time, so a command can sit queued
    // for minutes; stopping during that wait must still cancel it, and both
    // timestamps come from the relay, so the comparison needs no clock sync.
    const turnStartedAt = Date.now();
    const sinceMs = Date.parse(command.created_at) || turnStartedAt;
    const stopWatching = watchForInterrupt(abortController, sinceMs);
    await checkInterrupt(abortController, sinceMs);

    let sawResult = false;
    try {
      if (abortController.signal.aborted) throw new Error("stopped before starting");
      const activeQuery = query({ prompt: input, options });
      // Live for the persistent kill-watcher to act against for as long as
      // this turn's subprocess is -- which can outlast the turn's own
      // `result` while one of its Background tasks is still running.
      currentQuery = activeQuery;
      for await (const message of activeQuery) {
        if (message.type === "system" && message.subtype === "init") {
          sdkSessionId = message.session_id;
          persist({ sdkSessionId });
          // A second (or third, ...) `init` inside this same query means a
          // Steer just landed: promote whichever Command was streamed in to
          // `running` and make it the one this loop is now tracking. A no-op
          // on the very first `init`, where nothing is pending yet.
          if (currentTurn?.pendingSteerSeq) {
            promoteToRunning(currentTurn.pendingSteerSeq);
            currentTurn.activeSeq = currentTurn.pendingSteerSeq;
            currentTurn.pendingSteerSeq = undefined;
          }
          // Each sub-turn gets its own allowance to be Steered again -- a
          // steered exchange is a conversation, not a single correction.
          if (currentTurn) currentTurn.steeredThisSubTurn = false;
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
        const steered = message.type === "result" && !!currentTurn?.pendingSteerSeq;
        if (message.type === "result") {
          sawResult = true;
          // This sub-turn just ended. If a Steer landed, its entry is already
          // in the in-flight set (added `queued` by watchForSteers) and gets
          // promoted on the next `init` above, so releasing this one doesn't
          // make the relay-facing fact flicker false in between.
          if (currentTurn) await release(currentTurn.activeSeq);
        }
        const mapped = mapMessage(message);
        if (steered) {
          for (const evt of mapped) {
            if (evt.type === "turn_complete") evt.no_notify = true;
          }
          eventBuffer.push({ type: "status", text: "steered" });
        }
        trackBackgroundTasks(mapped);
        eventBuffer.push(...mapped);
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
          eventBuffer.push({ type: "error", text: (e as Error).message, is_error: true });
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
      currentQuery = undefined;
      // The SDK may or may not emit a `result` for an aborted turn. Emitting
      // turn_complete unconditionally on abort guarantees the phone's composer
      // comes back; a duplicate divider is far cheaper than a stuck UI.
      if (abortController.signal.aborted) {
        eventBuffer.push({ type: "status", text: "turn stopped" });
        if (!sawResult) {
          eventBuffer.push({
            type: "turn_complete",
            duration_ms: Date.now() - turnStartedAt,
          });
        }
      }
      if (currentTurn) {
        // A Steer streamed in but never confirmed by a fresh `init` before
        // this query ended. Stop ending the query is the only case this
        // reports right now: the brake starting fresh work is not a brake, so
        // it must not be left to run and cannot wait for a restart that isn't
        // coming. Any other unconfirmed case (a genuine crash) is instead
        // left in the in-flight set for the next start to report -- it is
        // still there, `queued`, since nothing here removes it.
        if (currentTurn.pendingSteerSeq && abortController.signal.aborted) {
          await discard(currentTurn.pendingSteerSeq);
        }
        // Idempotent: already released by the `result` handling above in the
        // ordinary case, so this only does anything for an abort or an
        // unexpected error that left the active entry behind.
        await release(currentTurn.activeSeq);
      }
      currentTurn = undefined;
    }
  }

  let shuttingDown = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  /**
   * Stops the loop and flushes. Deliberately does not end the relay session:
   * leaving it alive is what lets the next start resume it without the phone
   * having to pair again. Ending a session is an explicit act, done by
   * `crc stop --end`.
   */
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    clearInterval(flushTimer);
    stopWatchingKills();
    stopWatchingSteers();
    if (!sessionEnded) await flushEvents().catch(() => undefined);
    resolveDone();
  }

  const onSignal = () => {
    void shutdown().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  void (async () => {
    while (running) {
      // Work already claimed but not yet run -- a Steer's turn found more
      // than it could accept, or claimed something in the gap the cursor
      // rule opens. Drained in the order it was claimed, before the relay is
      // polled again, so it is never rewound, re-fetched, or dropped.
      while (handBackBuffer.length > 0 && running) {
        const command = handBackBuffer.shift()!;
        promoteToRunning(command.seq);
        await runTurn(command);
      }
      if (!running) break;

      let commands;
      try {
        commands = await client.pollCommands(since);
      } catch (e) {
        if (e instanceof SessionEndedError) break;
        console.error("Poll failed, retrying:", (e as Error).message);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      for (const command of commands) {
        if (!running) break;
        // The cursor advances *before* the turn runs, so a connector that dies
        // mid-turn never re-runs it against a tree it has already half-changed.
        // `inFlight` is what lets the next start report that it was dropped.
        await claim(command, "running");
        await runTurn(command);
      }

      if (running) await sleep(POLL_INTERVAL_MS);
    }
    await shutdown();
  })();

  return { phoneUrl, sessionId: client.sessionId, resumed: resumed !== undefined, done };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
