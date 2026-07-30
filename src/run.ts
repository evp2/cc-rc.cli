import type { CanUseTool, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

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

  // A turn recorded as in flight by a previous process never completed -- the
  // connector died during it. Its cursor was already advanced, so it will not
  // be re-run; say so rather than letting it vanish silently.
  if (resumed?.inFlight) {
    console.log(`Reporting turn interrupted by restart: ${resumed.inFlight.seq}`);
    eventBuffer.push({
      type: "error",
      text:
        "The previous turn was interrupted when the connector stopped, and will " +
        "not be re-run automatically. Send it again if you still want it.",
      is_error: true,
    });
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
  let currentQuery: { stopTask(taskId: string): Promise<void> } | undefined;

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

  const flushTimer = setInterval(() => {
    void flushEvents();
  }, FLUSH_INTERVAL_MS);
  const stopWatchingKills = watchForKills();

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
    return waitForAnswer(input, toolOpts.toolUseID, toolOpts.signal);
  };

  async function runTurn(command: CommandRecord): Promise<void> {
    const text = command.text;
    const abortController = new AbortController();
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
      const activeQuery = query({ prompt: text, options });
      // Live for the persistent kill-watcher to act against for as long as
      // this turn's subprocess is -- which can outlast the turn's own
      // `result` while one of its Background tasks is still running.
      currentQuery = activeQuery;
      for await (const message of activeQuery) {
        if (message.type === "system" && message.subtype === "init") {
          sdkSessionId = message.session_id;
          persist({ sdkSessionId });
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
        if (message.type === "result") sawResult = true;
        const mapped = mapMessage(message);
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
    if (!sessionEnded) await flushEvents().catch(() => undefined);
    resolveDone();
  }

  const onSignal = () => {
    void shutdown().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  void (async () => {
    let since = state.commandCursor;
    while (running) {
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
        since = command.seq;
        persist({ commandCursor: command.seq, inFlight: { seq: command.seq, text: command.text } });
        await runTurn(command);
        persist({ inFlight: undefined });
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
