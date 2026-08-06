/** One skill the connector discovered, for the phone's "/" menu. */
export interface SkillInfo {
  name: string;
  description: string;
  argumentHint: string;
}

export interface CommandRecord {
  seq: string;
  text: string;
  created_at: string;
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
  | "background_task_started"
  | "background_task_settled"
  | "background_tasks_changed";

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
 * Thin fetch wrapper around the relay's JSON API. One instance per connector
 * process -- created via `RelayClient.create()`, which also registers the
 * session.
 */
export class RelayClient {
  readonly sessionId: string;
  private readonly secret: string;
  private readonly relayBaseUrl: string;

  private constructor(relayBaseUrl: string, sessionId: string, secret: string) {
    this.relayBaseUrl = relayBaseUrl;
    this.sessionId = sessionId;
    this.secret = secret;
  }

  static async create(
    relayBaseUrl: string,
    createSecret: string,
    input: CreateSessionInput,
  ): Promise<{ client: RelayClient; phoneUrl: string; netlifyUrl: string | undefined }> {
    const res = await fetch(`${relayBaseUrl}/sessions`, {
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
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      session_id: string;
      secret: string;
      phone_url: string;
      // Absent against an older relay deployment that predates this field.
      netlify_url?: string;
    };
    return {
      client: new RelayClient(relayBaseUrl, body.session_id, body.secret),
      phoneUrl: body.phone_url,
      netlifyUrl: body.netlify_url,
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
  ): Promise<RelayClient> {
    const client = new RelayClient(relayBaseUrl, sessionId, secret);
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

  get sessionSecret(): string {
    return this.secret;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.secret}` };
  }

  /** Throws {@link SessionEndedError} once the relay reports the session gone. */
  async pollCommands(since?: string): Promise<CommandRecord[]> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await fetch(
      `${this.relayBaseUrl}/sessions/${this.sessionId}/commands${qs}`,
      { headers: this.authHeaders() },
    );
    await checkTerminal(res);
    if (!res.ok) throw new Error(`pollCommands failed: HTTP ${res.status}`);
    const body = (await res.json()) as { commands: CommandRecord[] };
    return body.commands;
  }

  /** Throws {@link SessionEndedError} once the relay reports the session gone. */
  async postEvents(events: EventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    const res = await fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/events`, {
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
    const res = await fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}`, {
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
  async putSkills(skills: SkillInfo[], localCommands: SkillInfo[]): Promise<void> {
    const res = await fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ skills, local_commands: localCommands }),
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
    const res = await fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/in-flight`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ in_flight: inFlight }),
    });
    await checkTerminal(res);
    if (!res.ok) {
      throw new Error(`setInFlight failed: HTTP ${res.status} ${await res.text()}`);
    }
  }

  /** Best-effort -- called during shutdown, failures are not actionable. */
  async end(): Promise<void> {
    await fetch(`${this.relayBaseUrl}/sessions/${this.sessionId}/end`, {
      method: "POST",
      headers: this.authHeaders(),
    }).catch(() => undefined);
  }
}
