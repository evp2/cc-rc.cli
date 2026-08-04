import { PERMISSION_MODE, type ConnectorConfig } from "../config";
import { buildProviderEnv } from "../provider";
import { createSdkMessageMapper } from "../sdk/bridge";
import { RelayClient, SessionEndedError } from "../relay/client";
import { probeSkills } from "../skills";
import { readState, type ConnectorState } from "../state";
import { claim, persist, promoteToRunning, publishSkills, reportInFlight } from "./commands";
import type { SessionContext } from "./context";
import { flushEvents } from "./events";
import { runTurn } from "./turn";
import { watchForKills, watchForSteers } from "./watchers";

const POLL_INTERVAL_MS = 1750;
const FLUSH_INTERVAL_MS = 750;
// Roughly the phone's own status-poll cadence, so a corrected value is never
// more than about one of the phone's own polls late.
const INFLIGHT_RECONCILE_INTERVAL_MS = 5000;

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

  const ctx: SessionContext = {
    client,
    config,
    providerEnv,
    // One mapper for the whole process: it remembers the session banner
    // across turns so it is announced once, not above every reply.
    mapMessage: createSdkMessageMapper(),
    state: {
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
    },
    lastSkillsJson: undefined,
    sdkSessionId: resumed?.sdkSessionId,
    since: resumed?.commandCursor,
    eventBuffer: [],
    running: true,
    sessionEnded: false,
    runningTasks: [],
    lastHandledKillAt: undefined,
    inFlightEntries: new Map(),
    handBackBuffer: [],
    questionPending: false,
    currentTurn: undefined,
    currentQuery: undefined,
    flushChain: Promise.resolve(),
  };

  persist(ctx, {});

  // Populates the phone's menu before the first turn ever runs. Spawns a
  // throwaway query() purely to read the skill list -- see probeSkills for why
  // this costs no model spend. Not awaited: the phone URL should be handed
  // back immediately, and an empty menu for the few hundred ms this takes is
  // harmless.
  void (async () => {
    try {
      const { skills, localCommands } = await probeSkills(config.projectDir, providerEnv);
      await publishSkills(ctx, skills, localCommands);
    } catch (e) {
      console.error("Failed to probe skills at startup:", (e as Error).message);
    }
  })();

  // Every Command recorded as in flight by a previous process never
  // completed -- the connector died holding it. Cursors for all of them were
  // already advanced, so none will be re-run; say so rather than letting them
  // vanish silently. A `running` entry was genuinely cut off mid-turn; a
  // `queued` one (a Steer that had been claimed, or hand-back work) never
  // started at all, so calling it "interrupted" would say something false.
  if (resumed?.inFlight?.length) {
    for (const entry of resumed.inFlight) {
      console.log(`Reporting ${entry.status} command dropped by restart: ${entry.seq}`);
      ctx.eventBuffer.push({
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
    persist(ctx, { inFlight: undefined });
    // The relay still has whatever in_flight the dead process last reported
    // -- true, if it died mid-turn. Nothing else will ever correct that: a
    // fresh process starts with an empty inFlightEntries, so claim()'s own
    // wasEmpty check will not fire again until a *new* Command arrives, and
    // until one does (and completes), the phone's brake and Thinking
    // indicator would otherwise be stuck true indefinitely.
    await reportInFlight(ctx, false);
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
      ctx.eventBuffer.push({
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
    ctx.eventBuffer.push({ type: "background_tasks_changed", tasks: [] });
    persist(ctx, { runningTasks: undefined });
  }

  const flushTimer = setInterval(() => {
    void flushEvents(ctx);
  }, FLUSH_INTERVAL_MS);
  // reportInFlight (see commands.ts) is best-effort: a lost or failed PUT
  // otherwise strands the relay's belief until the next claim()/release()
  // transition, which may not come for a long time (or ever, if nothing new
  // is sent). This periodically re-asserts the connector's own current truth
  // regardless of whether anything changed, so a stranded flag self-heals
  // within one interval instead of staying wrong indefinitely.
  const inFlightReconcileTimer = setInterval(() => {
    void reportInFlight(ctx, ctx.inFlightEntries.size > 0);
  }, INFLIGHT_RECONCILE_INTERVAL_MS);
  const stopWatchingKills = watchForKills(ctx);
  const stopWatchingSteers = watchForSteers(ctx);

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
    ctx.running = false;
    clearInterval(flushTimer);
    clearInterval(inFlightReconcileTimer);
    stopWatchingKills();
    stopWatchingSteers();
    if (!ctx.sessionEnded) await flushEvents(ctx).catch(() => undefined);
    resolveDone();
  }

  const onSignal = () => {
    void shutdown().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  void (async () => {
    while (ctx.running) {
      // Work already claimed but not yet run -- a Steer's turn found more
      // than it could accept, or claimed something in the gap the cursor
      // rule opens. Drained in the order it was claimed, before the relay is
      // polled again, so it is never rewound, re-fetched, or dropped.
      while (ctx.handBackBuffer.length > 0 && ctx.running) {
        const command = ctx.handBackBuffer.shift()!;
        promoteToRunning(ctx, command.seq);
        await runTurn(ctx, command);
      }
      if (!ctx.running) break;

      let commands;
      try {
        commands = await client.pollCommands(ctx.since);
      } catch (e) {
        if (e instanceof SessionEndedError) break;
        console.error("Poll failed, retrying:", (e as Error).message);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      for (const command of commands) {
        if (!ctx.running) break;
        // The cursor advances *before* the turn runs, so a connector that dies
        // mid-turn never re-runs it against a tree it has already half-changed.
        // `inFlight` is what lets the next start report that it was dropped.
        await claim(ctx, command, "running");
        await runTurn(ctx, command);
      }

      if (ctx.running) await sleep(POLL_INTERVAL_MS);
    }
    await shutdown();
  })();

  return { phoneUrl, sessionId: client.sessionId, resumed: resumed !== undefined, done };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
