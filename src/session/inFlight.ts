import { SessionEndedError, type CommandRecord, type EventInput } from "../relay/client";
import type { ConnectorState } from "../state";

export type ClaimStatus = "running" | "queued";

export interface ClaimEntry {
  seq: string;
  text: string;
  status: ClaimStatus;
}

/**
 * Everything this module reaches outside itself, injected rather than
 * imported, so its own tests can drive it without a relay, a state file or a
 * console.
 */
export interface InFlightDeps {
  /** The relay-facing report. Failures are swallowed -- see {@link InFlight.reconcileOnce}. */
  setInFlight(inFlight: boolean): Promise<void>;
  /** Mirrors a slice of the connector's durable state. Never throws. */
  persist(patch: Partial<ConnectorState>): void;
  /** Buffers one Event for the phone. */
  emit(event: EventInput): void;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * The claims one Turn holds, handed to the body of {@link InFlight.duringTurn}.
 * Obtained there or via {@link InFlight.current}; never constructed directly,
 * because a handle that outlived its Turn is exactly the drift this module
 * exists to make impossible.
 */
export interface TurnClaims {
  /** The Command whose entry is `running` right now. */
  readonly activeSeq: string;
  /** Set the instant a Steer is streamed in, cleared once a fresh `init` confirms it landed. */
  readonly pendingSteerSeq: string | undefined;
  /** Claims a Command as this Turn's one Steer, before it is streamed in. */
  steer(command: CommandRecord): Promise<void>;
  /**
   * A fresh `init` confirmed the Steer: it becomes the Turn's active Command,
   * and whatever was active before it is released.
   */
  confirmSteer(): Promise<void>;
  /** The Steer never reached the query. Reported to the phone, not left claimed. */
  abandonSteer(): Promise<void>;
  /** This sub-turn produced its `result`. */
  settleActive(): Promise<void>;
}

class TurnClaimsImpl implements TurnClaims {
  activeSeq: string;
  pendingSteerSeq: string | undefined;
  /**
   * Every Command this Turn has made active, including ones a later Steer
   * superseded. `activeSeq` alone is not enough to unwind by: it is
   * overwritten on each confirmed Steer, so a Command it no longer names is a
   * Command nothing else would ever release.
   */
  readonly claimedSeqs = new Set<string>();

  constructor(
    activeSeq: string,
    private readonly owner: InFlight,
  ) {
    this.activeSeq = activeSeq;
    this.claimedSeqs.add(activeSeq);
  }

  async steer(command: CommandRecord): Promise<void> {
    this.pendingSteerSeq = command.seq;
    await this.owner.hold(command, "queued");
  }

  /**
   * Promotes the Steer before releasing the Command it supersedes, so the
   * relay-facing fact never flickers false across the seam between two
   * sub-turns of the same Turn.
   *
   * The release is not redundant with settleActive(): that only runs if the
   * superseded sub-turn reports a `result`, and an `init` can arrive first --
   * or instead. Settling here is idempotent, so the ordinary
   * result-then-init case reaches this having nothing left to release.
   */
  async confirmSteer(): Promise<void> {
    const seq = this.pendingSteerSeq;
    if (!seq) return;
    const superseded = this.activeSeq;
    this.pendingSteerSeq = undefined;
    this.activeSeq = seq;
    this.claimedSeqs.add(seq);
    this.owner.promote(seq);
    if (superseded !== seq) await this.owner.settle(superseded);
  }

  async abandonSteer(): Promise<void> {
    const seq = this.pendingSteerSeq;
    if (!seq) return;
    this.pendingSteerSeq = undefined;
    await this.owner.drop(seq);
  }

  async settleActive(): Promise<void> {
    await this.owner.settle(this.activeSeq);
  }
}

/**
 * The connector's authoritative record of every Command it holds but has not
 * finished -- what the phone's brake and Thinking placeholder both ultimately
 * read, and what a restart reads to say what it dropped.
 *
 * Two facts are kept together here deliberately, because keeping them apart is
 * what lets them drift: the set of held Commands, and the command-log cursor.
 * Claiming a Command *is* advancing the cursor past it -- a Command at or below
 * the cursor is never executed again -- so one method does both and no caller
 * can do one without the other.
 *
 * The same reasoning drives {@link duringTurn}. A Turn's claims used to be
 * unwound by hand at the end of the function that ran it, correct only by
 * inspection of every path that function could exit by; one such path (a Local
 * command answered by the CLI itself, which ends the query without ever
 * emitting the fresh `init` that would confirm it) left its claim held for the
 * life of the process, with the phone's brake stuck on against a session that
 * had finished long ago. Running a Turn inside a scope that sweeps whatever is
 * still held on exit makes that class of bug unwritable rather than merely
 * absent.
 */
export class InFlight {
  private readonly entries = new Map<string, ClaimEntry>();
  private cursorSeq: string | undefined;
  private live: TurnClaimsImpl | undefined;
  private readonly deps: InFlightDeps;

  constructor(deps: InFlightDeps, opts: { cursor?: string } = {}) {
    this.deps = deps;
    this.cursorSeq = opts.cursor;
  }

  /** Where the next command poll should read from. */
  get cursor(): string | undefined {
    return this.cursorSeq;
  }

  /** Shaped for the state file, which omits the field entirely when nothing is held. */
  snapshot(): ClaimEntry[] | undefined {
    return this.entries.size ? [...this.entries.values()] : undefined;
  }

  /**
   * The claims of the Turn running right now, if one is. Identity is the point:
   * a caller that captured this before an await can compare what it gets back
   * afterwards and know whether the Turn it was acting for is still the current
   * one.
   */
  current(): TurnClaims | undefined {
    return this.live;
  }

  /**
   * Claims a Command freshly read off the relay: advances the cursor and adds
   * it to the held set. Reports in-flight to the relay exactly once, on the
   * transition from holding nothing to holding something, so a run of queued
   * work reads as continuous rather than flickering.
   */
  async hold(command: CommandRecord, status: ClaimStatus): Promise<void> {
    const wasEmpty = this.entries.size === 0;
    this.entries.set(command.seq, { seq: command.seq, text: command.text, status });
    this.cursorSeq = command.seq;
    this.mirror();
    if (wasEmpty) await this.report(true);
  }

  /** Moves an already-held Command to `running`. No cursor movement -- holding it already advanced the cursor. */
  promote(seq: string): void {
    const entry = this.entries.get(seq);
    if (!entry || entry.status === "running") return;
    entry.status = "running";
    this.mirror();
  }

  /** A Command's Turn has ended. Reports in-flight false exactly on the transition to holding nothing. */
  async settle(seq: string): Promise<void> {
    if (!this.entries.delete(seq)) return;
    this.mirror();
    if (this.entries.size === 0) await this.report(false);
  }

  /**
   * Settles a Command that never ran, and says so on the phone.
   *
   * Reported the moment it happens, not at a later restart -- a brake that
   * starts fresh work is not a brake, and no restart is coming to explain a
   * sentence that just vanished while the human was watching the screen.
   */
  async drop(seq: string): Promise<void> {
    const entry = this.entries.get(seq);
    this.deps.emit({ type: "command_discarded", text: entry?.text });
    await this.settle(seq);
  }

  /**
   * Runs one Turn's body with its claims held, and sweeps whatever is still
   * held when the body returns or throws.
   *
   * `signal` is read, never triggered: it is the only thing that distinguishes
   * the two ways a Steer can still be pending at the end. Under Stop it is
   * discarded, visibly -- the brake starting fresh work is not a brake.
   * Otherwise it reached the SDK and was absorbed into the Turn that just
   * ended, so it is simply done and the claim has to go. The active Command is
   * always settled rather than discarded: its Turn genuinely ran, and has
   * already reported its own outcome.
   *
   * Leaving either for a restart to report is not an option. This sweep only
   * runs because the process is alive; a genuine crash skips it entirely and
   * the state file still carries the entries for the next start to explain.
   */
  async duringTurn<T>(
    command: CommandRecord,
    signal: AbortSignal,
    body: (claims: TurnClaims) => Promise<T>,
  ): Promise<T> {
    // Held if this Turn came from the hand-back buffer, where it was claimed
    // `queued` by the poll that found it; fresh off the relay otherwise.
    if (this.entries.has(command.seq)) this.promote(command.seq);
    else await this.hold(command, "running");

    const claims = new TurnClaimsImpl(command.seq, this);
    this.live = claims;
    try {
      return await body(claims);
    } finally {
      this.live = undefined;
      if (claims.pendingSteerSeq) {
        if (signal.aborted) await this.drop(claims.pendingSteerSeq);
        else await this.settle(claims.pendingSteerSeq);
      }
      // Idempotent: settled by the body already in the ordinary case, so this
      // only does anything for an abort or an unexpected error. Every Command
      // the Turn made active is swept, not just the last -- a Turn steered
      // more than once has more than one, and a Command left behind by a
      // superseded sub-turn is held for the life of the process.
      for (const seq of claims.claimedSeqs) await this.settle(seq);
    }
  }

  /**
   * Explains what a previous process died holding, and corrects the relay.
   *
   * Every Command recorded as held by a previous process never completed. Their
   * cursors were already advanced, so none will be re-run; say so rather than
   * letting them vanish silently. A `running` entry was genuinely cut off
   * mid-turn; a `queued` one (a Steer that had been claimed, or hand-back work)
   * never started at all, so calling it "interrupted" would say something
   * false.
   */
  async resumeFrom(previous: ClaimEntry[] | undefined): Promise<void> {
    if (!previous?.length) return;
    for (const entry of previous) {
      this.deps.log?.(`Reporting ${entry.status} command dropped by restart: ${entry.seq}`);
      this.deps.emit({
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
    this.deps.persist({ inFlight: undefined });
    // The relay still has whatever the dead process last reported -- true, if
    // it died mid-turn. Nothing else will ever correct that: this process
    // starts holding nothing, so hold()'s own transition check will not fire
    // again until a *new* Command arrives, and until one does (and completes),
    // the phone's brake and Thinking indicator would be stuck true.
    await this.report(false);
  }

  /**
   * Re-asserts the current truth regardless of whether anything changed.
   *
   * {@link report} is best-effort, so a lost or failed report otherwise strands
   * the relay's belief until the next hold/settle transition, which may not
   * come for a long time -- or ever, if nothing new is sent. Called on a timer
   * by the session loop, which owns the interval rather than this module, so
   * the module stays drivable from a test without fake timers.
   */
  async reconcileOnce(): Promise<void> {
    await this.report(this.entries.size > 0);
  }

  private mirror(): void {
    this.deps.persist({ commandCursor: this.cursorSeq, inFlight: this.snapshot() });
  }

  /** Best-effort: a failed report leaves the phone's brake stale until the next reconcile, not broken. */
  private async report(inFlight: boolean): Promise<void> {
    try {
      await this.deps.setInFlight(inFlight);
    } catch (e) {
      if (e instanceof SessionEndedError) return;
      this.deps.error?.(`Failed to report in-flight state: ${(e as Error).message}`);
    }
  }
}
