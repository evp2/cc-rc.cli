import { CONNECTOR_VERSION } from "../version";

/** One skill the connector discovered, for the phone's "/" menu. */
export interface SkillInfo {
  name: string;
  description: string;
  argumentHint: string;
}

/** Who submitted a Command. `auto` is this connector's own idle-triggered Auto-compact; `phone` (the default when absent) is the phone client. */
export type CommandSource = "phone" | "auto";

export interface CommandRecord {
  seq: string;
  text: string;
  created_at: string;
  source?: CommandSource;
}

/** The phone's structured reply to a pending Question, as the relay stores and reports it. */
export interface AnswerRecord {
  tool_use_id: string;
  answers: Record<string, string>;
  response?: string;
}

export type EventType =
  | "status"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "question"
  | "turn_complete"
  | "error"
  | "command_discarded"
  | "background_task_started"
  | "background_task_settled"
  | "background_tasks_changed"
  | "usage";

/** How a Background task ended. `interrupted` is the connector's own outcome for a task a process restart killed, not one the SDK reports. */
export type TaskStatus = "completed" | "failed" | "stopped" | "interrupted";

/** One row of the live-task set carried by a `background_tasks_changed` event -- ids only, per the SDK's REPLACE-semantics level signal. */
export interface BackgroundTaskRow {
  task_id: string;
  task_type?: string;
  description?: string;
}

export interface EventInput {
  type: EventType;
  text?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  cost_usd?: number;
  duration_ms?: number;
  /** Background-task id, on the started/settled events. */
  task_id?: string;
  /** How a Background task settled, on the settled event. */
  task_status?: TaskStatus;
  /** Friendly task-type label (shell, subagent, ...), on started and in the changed set. */
  task_type?: string;
  /** True for an ambient (skip_transcript) task -- kept out of the inline transcript and shown dimmed in the tray. */
  is_ambient?: boolean;
  /** The full live-task set, on the changed event. REPLACE semantics. */
  tasks?: BackgroundTaskRow[];
  /** On a `turn_complete` for a Turn that accepted a Steer -- tells the relay to skip the Web Push. */
  no_notify?: boolean;
  /** Rounded percent of the model's context window in use, on `turn_complete` and the compact-boundary `status` event. Omitted when the SDK's `getContextUsage()` call failed. */
  context_percentage?: number;
  /** True on the `turn_complete`/`status` event where `context_percentage` just crossed the configured Context-window-warning threshold (see CONTEXT.md) -- edge-triggered, so only the event that caused the crossing carries it. */
  context_warning?: boolean;
  /** True on a `status` event fired just before the SDK compacts the conversation on its own -- a Context-window overflow (see CONTEXT.md and ADR 0024), never set for a connector- or human-issued `/compact`. */
  context_overflow?: boolean;
  /** Token counts off the SDK's result message, carried on every `usage` event alongside `cost_usd`. */
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** On a `usage` event, already in the relay's `<host>#<org>/<repo>` Contributions key shape. Absent when the working directory has no git remote. */
  repo?: string;
}

export interface CreateSessionInput {
  permissionMode: string;
  providerType: "anthropic" | "bedrock";
  providerModel?: string;
  providerRegion?: string;
  projectDir: string;
}

/** Thrown when the relay reports the session no longer exists or has ended. */
export class SessionEndedError extends Error {
  constructor() {
    super("session has ended");
    this.name = "SessionEndedError";
  }
}

async function checkTerminal(res: Response): Promise<void> {
  if (res.status === 410 || res.status === 404) throw new SessionEndedError();
}

/**
 * How long a relay request may hang before it is treated as failed.
 *
 * Observed in production without this: a `setInFlight` call whose connection
 * hung never resolved or rejected, so `duringTurn`'s cleanup -- and with it
 * the connector's single, sequential main loop -- waited on it forever.
 * `in_flight` stayed stuck true and no later command was ever picked up,
 * indefinitely, because nothing was left to time it out.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** fetch(), bounded by {@link DEFAULT_REQUEST_TIMEOUT_MS} (or a caller-supplied override, so tests can prove the bound without waiting out a real hang). */
function boundedFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Thin fetch wrapper around the relay's JSON API. One instance per connector
 * process -- created via `RelayClient.create()`, which also registers the
 * session.
 */
export class RelayClient {
  readonly sessionId: string;
  private readonly secret: string;
  private readonly relayBaseUrl: string;
  private readonly requestTimeoutMs: number;

  private constructor(
    relayBaseUrl: string,
    sessionId: string,
    secret: string,
    requestTimeoutMs: number,
  ) {
    this.relayBaseUrl = relayBaseUrl;
    this.sessionId = sessionId;
    this.secret = secret;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    return boundedFetch(url, init, this.requestTimeoutMs);
  }

  static async create(
    relayBaseUrl: string,
    createSecret: string,
    input: CreateSessionInput,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{
    client: RelayClient;
    phoneUrl: string;
    staticUrl: string | undefined;
    controlUrl: string | undefined;
  }> {
    const res = await boundedFetch(
      `${relayBaseUrl}/sessions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Create-Secret": createSecret,
        },
        body: JSON.stringify({
          permission_mode: input.permissionMode,
          provider_type: input.providerType,
          provider_model: input.providerModel,
          provider_region: input.providerRegion,
          project_dir: input.projectDir,
        }),
      },
      requestTimeoutMs,
    );
    if (!res.ok) {
      throw new Error(`Failed to create session: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      session_id: string;
      secret: string;
      phone_url: string;
      // Absent against an older relay deployment that predates this field.
      netlify_url?: string;
      // Likewise -- see `fetchControlUrl` for the session that predates it.
      control_url?: string;
    };
    return {
      client: new RelayClient(relayBaseUrl, body.session_id, body.secret, requestTimeoutMs),
      phoneUrl: body.phone_url,
      staticUrl: body.netlify_url,
      controlUrl: body.control_url,
    };
  }

  /**
   * Rejoins a session the connector already holds credentials for, rather than
   * creating a new one, so that an ordinary restart stays invisible to the
   * phone: it keeps its stored credentials and never has to pair again. The
   * status probe is what distinguishes a
   * session that is still good from one that has ended or aged out, so callers
   * can fall back to {@link RelayClient.create} on {@link SessionEndedError}.
   */
  static async resume(
    relayBaseUrl: string,
    sessionId: string,
    secret: string,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<RelayClient> {
    const client = new RelayClient(relayBaseUrl, sessionId, secret, requestTimeoutMs);
    await client.getSession();
    return client;
  }

  /**
   * The phone URL for this session. Rebuilt rather than stored so that
   * `crc qr` can render one for a resumed session, whose original URL was
   * printed by a process that has since exited.
   */
  phoneUrl(): string {
    return `${this.relayBaseUrl}/?s=${this.sessionId}&k=${encodeURIComponent(this.secret)}`;
  }

  /**
   * The short Control URL for this session, asked of the relay rather than
   * rebuilt like {@link phoneUrl}: the code lives only in the session record,
   * and a session created before control codes existed has one minted on the
   * first ask. Undefined against a relay that predates the route, which is the
   * one case a caller has nothing to print.
   */
  async fetchControlUrl(): Promise<string | undefined> {
    const res = await this.fetch(
      `${this.relayBaseUrl}/sessions/${this.sessionId}/control-code`,
      { method: "POST", headers: this.authHeaders() },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { control_url?: string };
    return body.control_url;
  }

  get sessionSecret(): string {
    return this.secret;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.secret}` };
  }

  /** Throws {@link SessionEndedError} once the relay reports the session gone. */
  async pollCommands(since?: string): Promise<CommandRecord[]> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await this.fetch(
      `${this.relayBaseUrl}/sessions/${this.sessionId}/commands${qs}`,
      { headers: this.authHeaders() },
    );
    await checkTerminal(res);
    if (!res.ok) throw new Error(`pollCommands failed: HTTP ${res.status}`);
    const body = (await res.json()) as { commands: CommandRecord[] };
    return body.commands;
  }

  /**
   * Submits a Command as this connector, not the phone -- currently only used
   * for Auto-compact. Both sides authenticate with the same session bearer
   * secret, so the `X-Crc-Client: connector` header is what tells the relay to
   * tag the stored Command `source: "auto"` and attribute liveness to the
   * connector, rather than falsely marking the phone as just seen.
   *
   * Throws {@link SessionEndedError} once the relay reports the session gone.
   */
  async postCommand(text: string): Promise<{ seq: string; created_at: string }> {
    const res = await this.fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Crc-Client": "connector",
        ...this.authHeaders(),
      },
      body: JSON.stringify({ text }),
    });
    await checkTerminal(res);
    if (!res.ok) {
      throw new Error(`postCommand failed: HTTP ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { seq: string; created_at: string };
  }

  /** Throws {@link SessionEndedError} once the relay reports the session gone. */
  async postEvents(events: EventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    const res = await this.fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ events }),
    });
    await checkTerminal(res);
    if (!res.ok) {
      throw new Error(`postEvents failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { accepted: number };
    return body.accepted;
  }

  /**
   * Session metadata. Polled while a turn runs to pick up a stop request from
   * the phone (`interrupt_at`) or a submitted Answer to a pending Question
   * (`answer`).
   *
   * Throws {@link SessionEndedError} once the relay reports the session gone.
   */
  async getSession(
    opts: { heartbeat?: boolean } = {},
  ): Promise<{
    interrupt_at?: string;
    last_connector_seen_at?: string;
    answer?: AnswerRecord;
    kill_task?: { task_id: string; requested_at: string };
  }> {
    // Only the running session loop may mark the session as contacted. Tools
    // that merely inspect it (`crc status`, `crc qr`) must not, or they would
    // convince the phone a connector is alive when none is running and unblock
    // its composer with nothing behind it.
    const headers = opts.heartbeat
      ? { ...this.authHeaders(), "X-Crc-Client": "connector" }
      : this.authHeaders();
    const res = await this.fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}`, {
      headers,
    });
    await checkTerminal(res);
    if (!res.ok) throw new Error(`getSession failed: HTTP ${res.status}`);
    return (await res.json()) as {
      interrupt_at?: string;
      last_connector_seen_at?: string;
      answer?: AnswerRecord;
      kill_task?: { task_id: string; requested_at: string };
    };
  }

  /**
   * Publishes the connector's current view of its skills and Local commands,
   * replacing whatever was published before. Best-effort: a failed publish
   * leaves the phone's menu stale rather than blocking anything a human is
   * waiting on, so callers log and move on rather than retry.
   */
  async putSkills(
    skills: SkillInfo[],
    localCommands: SkillInfo[],
    inactivityCompactAfterMinutes?: number,
  ): Promise<void> {
    const res = await this.fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        skills,
        local_commands: localCommands,
        connector_version: CONNECTOR_VERSION,
        // Absent means Auto-compact is off for this connector -- distinct from
        // an old connector that predates this field, which the relay tells
        // apart by connector_version also being absent.
        ...(inactivityCompactAfterMinutes !== undefined
          ? { inactivity_compact_after_minutes: inactivityCompactAfterMinutes }
          : {}),
      }),
    });
    await checkTerminal(res);
    if (!res.ok) {
      throw new Error(`putSkills failed: HTTP ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Reports whether the connector currently holds a Command it has not
   * finished -- the fact the phone's brake reads instead of guessing from the
   * transcript. Called at each boundary of a run of work, not per poll.
   *
   * Throws {@link SessionEndedError} once the relay reports the session gone.
   */
  async setInFlight(inFlight: boolean): Promise<void> {
    const res = await this.fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/in-flight`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ in_flight: inFlight }),
    });
    await checkTerminal(res);
    if (!res.ok) {
      throw new Error(`setInFlight failed: HTTP ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Reports what one Turn committed. Called only for a Turn that committed
   * something, and nothing is buffered behind it: a report that fails is
   * simply lost, deliberately. In-memory state that never reaches the relay
   * is the failure mode behind both production bugs this connector has had,
   * and a line count is not worth reintroducing it for.
   *
   * Throws {@link SessionEndedError} once the relay reports the session gone.
   */
  async postContribution(input: {
    host?: string;
    repo?: string;
    added: number;
    deleted: number;
  }): Promise<void> {
    const res = await this.fetch(
      `${this.relayBaseUrl}/sessions/${this.sessionId}/contributions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(input),
      },
    );
    await checkTerminal(res);
    if (!res.ok) {
      throw new Error(`postContribution failed: HTTP ${res.status} ${await res.text()}`);
    }
  }

  /** Best-effort -- called during shutdown, failures are not actionable. */
  async end(): Promise<void> {
    await this.fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/end`, {
      method: "POST",
      headers: this.authHeaders(),
    }).catch(() => undefined);
  }
}
