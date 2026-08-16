import { PERMISSION_MODE, type ConnectorConfig, type InactivityCompactConfig } from "../config";
import { buildProviderEnv } from "../provider";
import { createSdkMessageMapper } from "../sdk/bridge";
import { RelayClient, SessionEndedError } from "../relay/client";
import { probeSkills } from "../skills";
import { readState, writeState, type ConnectorState } from "../state";
import { query } from "../sdk/client";
import { persist, publishSkills } from "./commands";
import type { SessionContext } from "./context";
import { flushEvents } from "./events";
import { InFlight } from "./inFlight";
import { runTurn } from "./turn";
import { watchForKills, watchForSteers } from "./watchers";

const POLL_INTERVAL_MS = 1750;
const FLUSH_INTERVAL_MS = 750;
// Roughly the phone's own status-poll cadence, so a corrected value is never
// more than about one of the phone's own polls late.
const INFLIGHT_RECONCILE_INTERVAL_MS = 5000;

/**
 * Whether Auto-compact should fire right now: at least one real Turn has ever
 * completed, the configured idle stretch has elapsed since then, and no
 * Auto-compact has already fired for this same idle stretch -- the last part
 * is what makes it fire once per idle period rather than repeating for as
 * long as the session stays untouched, with no separate suppression flag
 * needed.
 */
export function isAutoCompactDue(
  state: Pick<ConnectorState, "lastRealTurnCompletedAt" | "lastAutoCompactAt">,
  cfg: InactivityCompactConfig,
  now: number = Date.now(),
): boolean {
  if (!state.lastRealTurnCompletedAt) return false;
  const lastRealMs = Date.parse(state.lastRealTurnCompletedAt);
  const lastAutoMs = state.lastAutoCompactAt ? Date.parse(state.lastAutoCompactAt) : undefined;
  if (lastAutoMs !== undefined && lastAutoMs >= lastRealMs) return false;
  return now - lastRealMs >= cfg.afterMinutes * 60_000;
}

/**
 * Submits Auto-compact when it's due, through the same endpoint the phone
 * uses so it inherits the ordinary cursor/at-most-once/Steer handling every
 * other Command gets, rather than running as a special case here. Called once
 * per poll-loop tick, only when nothing is currently in flight -- the loop is
 * never mid-`runTurn` at this point, so "not busy" is automatic, not checked
 * explicitly.
 *
 * `lastAutoCompactAt` is persisted only on a confirmed submission, never
 * speculatively: a failed POST must retry on the next tick, not be silently
 * treated as fired.
 */
export async function maybeSubmitAutoCompact(ctx: SessionContext): Promise<void> {
  const cfg = ctx.config.inactivityCompact;
  if (!cfg || !isAutoCompactDue(ctx.state, cfg)) return;
  try {
    await ctx.client.postCommand("/compact");
    persist(ctx, { lastAutoCompactAt: new Date().toISOString() });
    console.log(`Auto-compact: submitted after ${cfg.afterMinutes}m idle.`);
  } catch (e) {
    if (e instanceof SessionEndedError) return;
    console.error("Failed to submit Auto-compact:", (e as Error).message);
  }
}

export interface RunHandle {
  phoneUrl: string;
  staticUrl: string | undefined;
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
async function acquireSession(config: ConnectorConfig): Promise<{
  client: RelayClient;
  phoneUrl: string;
  staticUrl: string | undefined;
  resumed: ConnectorState | undefined;
}> {
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
      return {
        client,
        phoneUrl: previous.phoneUrl || client.phoneUrl(),
        staticUrl: previous.staticUrl,
        resumed: previous,
      };
    } catch (e) {
      if (!(e instanceof SessionEndedError)) throw e;
      console.log("Previous session has ended; starting a new one.");
    }
  }

  const { client, phoneUrl, staticUrl } = await RelayClient.create(
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
  return { client, phoneUrl, staticUrl, resumed: undefined };
}

/**
 * Runs the session loop in the foreground until stopped. Returns once the
 * session is live, so a caller can report the phone URL before the loop ends.
 */
export async function runConnector(config: ConnectorConfig): Promise<RunHandle> {
  const providerEnv = buildProviderEnv(config.provider);
  const { client, phoneUrl, staticUrl, resumed } = await acquireSession(config);

  // Declared before the context so the ledger's dependencies can close over
  // it: the ledger persists and emits through the same paths everything else
  // does, and the context in turn holds the ledger.
  let ctx: SessionContext;
  const inFlight = new InFlight(
    {
      setInFlight: (value) => client.setInFlight(value),
      persist: (patch) => persist(ctx, patch),
      emit: (event) => {
        ctx.eventBuffer.push(event);
      },
      log: (message) => console.log(message),
      error: (message) => console.error(message),
    },
    { cursor: resumed?.commandCursor },
  );

  ctx = {
    client,
    config,
    providerEnv,
    query,
    writeState,
    inFlight,
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
      staticUrl,
      commandCursor: resumed?.commandCursor,
      sdkSessionId: resumed?.sdkSessionId,
      inFlight: undefined,
      // Auto-compact's `lastRealTurnCompletedAt`/`lastAutoCompactAt` are
      // omitted on purpose, not forgotten: a restart resets the idle clock so
      // this process waits for the human to do something before submitting
      // anything on their behalf. Seeding them from `resumed` would undo that.
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    lastSkillsJson: undefined,
    sdkSessionId: resumed?.sdkSessionId,
    eventBuffer: [],
    running: true,
    sessionEnded: false,
    runningTasks: [],
    lastHandledKillAt: undefined,
    handBackBuffer: [],
    questionPending: false,
    currentTurn: undefined,
    currentQuery: undefined,
    contextWarningActive: false,
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

  // Explains, and corrects the relay for, whatever a previous process died
  // holding.
  await inFlight.resumeFrom(resumed?.inFlight);

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
  // The interval lives here rather than inside the ledger, so the ledger stays
  // drivable from a test without fake timers.
  const inFlightReconcileTimer = setInterval(() => {
    void inFlight.reconcileOnce();
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
        await runTurn(ctx, command);
      }
      if (!ctx.running) break;

      // Nothing is in flight at this point in the loop -- runTurn is always
      // awaited before control gets back here -- so this is exactly the
      // "idle and not busy" moment Auto-compact's trigger condition needs.
      await maybeSubmitAutoCompact(ctx);

      let commands;
      try {
        commands = await client.pollCommands(inFlight.cursor);
      } catch (e) {
        if (e instanceof SessionEndedError) break;
        console.error("Poll failed, retrying:", (e as Error).message);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      for (const command of commands) {
        if (!ctx.running) break;
        // runTurn claims through the ledger on the way in, so the cursor
        // advances *before* the turn runs: a connector that dies mid-turn
        // never re-runs it against a tree it has already half-changed, and the
        // held record is what lets the next start report that it was dropped.
        await runTurn(ctx, command);
      }

      if (ctx.running) await sleep(POLL_INTERVAL_MS);
    }
    await shutdown();
  })();

  return { phoneUrl, staticUrl, sessionId: client.sessionId, resumed: resumed !== undefined, done };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
