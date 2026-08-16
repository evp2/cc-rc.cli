import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bumped only when a field's meaning changes; unknown versions are discarded. */
const STATE_VERSION = 1;

const STATE_DIR = join(homedir(), ".claude-remote-control");

/**
 * The connector's durable record for one project directory. It serves two jobs
 * at once: it is what a restarting connector resumes from, and it is what
 * `crc status` reports. Keeping them the same file means status can never
 * disagree with what the connector actually believes.
 */
export interface ConnectorState {
  version: number;
  /** Resolved absolute path -- also what the state file name is derived from. */
  projectDir: string;
  relayBaseUrl: string;
  sessionId: string;
  secret: string;
  phoneUrl: string;
  /** The Netlify share link for this session, if the relay minted one -- full access, no secret. */
  staticUrl?: string;
  /**
   * Seq of the most recent command *claimed*, written before the turn runs
   * rather than after it succeeds. A command at or below this is never executed
   * again: commands mutate a real checkout, so a turn that died halfway through
   * has already edited some files, and replaying it against that half-changed
   * tree can compound the damage with nobody watching. Losing a command is one
   * tap to recover; silently re-running a destructive one is not.
   */
  commandCursor?: string;
  /**
   * Every Command the connector currently holds but has not finished --
   * whichever one is actually executing (`running`), plus any claimed by a
   * poll (a Steer, or extra work found alongside it) but not yet started
   * (`queued`) via the hand-back buffer. Present in a state file left behind
   * by a crash, which is the only way the connector can tell what was
   * interrupted versus never run at all: a `running` entry was truly cut
   * off mid-turn, while a `queued` one never touched the tree, so reporting
   * both as "interrupted" would say something false about the queued one.
   */
  inFlight?: { seq: string; text: string; status: "running" | "queued" }[];
  /** Claude's own session id, resumed across turns. Dropped when rotating. */
  sdkSessionId?: string;
  /**
   * Background tasks the connector last saw running, kept so a restart can
   * report each as `interrupted` rather than leaving the phone's inline card
   * spinning forever: a Background task is a child of the CLI process, so the
   * process dying really does end it. Added on a non-ambient
   * `background_task_started`, removed on its `background_task_settled`.
   */
  runningTasks?: { task_id: string; tool_use_id?: string; description?: string }[];
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** Last fatal error, retained after exit so `crc status` can explain it. */
  lastError?: string;
  /**
   * When the last real (non-Auto-compact) Command's Turn finished. Auto-compact's
   * idle clock is measured from here, not from process start, so a session with
   * no activity yet never fires one.
   *
   * Deliberately *not* carried across a restart, unlike the cursor and the SDK
   * session id: a fresh process has to see the human do something before it
   * will submit anything on their behalf. Resuming the countdown instead would
   * let a connector started after a long gap fire a `/compact` into a session
   * nobody has touched yet.
   */
  lastRealTurnCompletedAt?: string;
  /**
   * When Auto-compact last actually submitted, set only once the relay confirms
   * it (never speculatively, so a failed submission retries on the next poll
   * tick rather than being silently treated as done). Compared against
   * `lastRealTurnCompletedAt` to decide whether Auto-compact has already fired
   * for the current idle stretch -- no separate suppression flag needed.
   *
   * Dropped on restart along with `lastRealTurnCompletedAt`, which costs
   * nothing: without an idle clock to compare against, a suppression marker
   * has nothing left to suppress.
   */
  lastAutoCompactAt?: string;
}

/**
 * State files are keyed by project directory rather than by pid so that a
 * restarted connector finds its own predecessor's session. The hash keeps the
 * name short and filesystem-safe while staying stable across restarts.
 */
export function stateKey(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
}

export function statePath(projectDir: string): string {
  return join(STATE_DIR, `${stateKey(projectDir)}.json`);
}

export function logPath(projectDir: string): string {
  return join(STATE_DIR, `${stateKey(projectDir)}.log`);
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Reads the state for a project directory, or undefined if there is none, it is
 * unreadable, or it was written by an incompatible version. A corrupt state file
 * is never fatal: the connector treats it as "no previous session" and rotates,
 * which costs a re-pair but always starts.
 */
export function readState(projectDir: string): ConnectorState | undefined {
  const path = statePath(projectDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ConnectorState;
    if (parsed.version !== STATE_VERSION) return undefined;
    if (!parsed.sessionId || !parsed.secret) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Writes state atomically, so a connector killed mid-write can never leave a
 * half-serialised file that would strand the next start. 0600 because the file
 * holds the session bearer secret.
 */
export function writeState(state: ConnectorState): void {
  ensureStateDir();
  const path = statePath(state.projectDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function clearState(projectDir: string): void {
  const path = statePath(projectDir);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Whether a process with this pid exists. Signal 0 performs the permission and
 * existence checks without delivering anything; EPERM means it exists but is
 * owned by someone else, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The live connector for a project directory, if there is one.
 *
 * A pid alone can be reused by an unrelated process after a hard reboot, so
 * callers that act on this (`crc stop`) should treat it as advisory. `crc
 * status` corroborates it against the relay's own view of when it last heard
 * from the connector, which no stale pid can fake.
 */
export function liveConnector(projectDir: string): ConnectorState | undefined {
  const state = readState(projectDir);
  if (!state) return undefined;
  return isProcessAlive(state.pid) ? state : undefined;
}

export { STATE_VERSION, STATE_DIR };
