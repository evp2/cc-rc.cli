import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** What one Turn committed, as the relay's contributions route accepts it. */
export interface Contribution {
  /** Remote host, e.g. "github.com". Absent together with `repo` when there is no origin to attribute to. */
  host?: string;
  /** "<org>/<repo>", in the same shape the pod queue uses. */
  repo?: string;
  added: number;
  deleted: number;
}

/**
 * Long enough that a cold index on a large repo still finishes, short enough
 * that a wedged git never becomes the connector's problem: measuring is
 * bookkeeping, and a Turn's completion must not wait on it.
 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Runs git in the project directory. Returns undefined for *any* failure --
 * a directory that is not a repository, a git that isn't installed, a
 * timeout. Nothing here is worth failing or delaying a Turn over, and the
 * common case (no repo) is not an error at all.
 */
async function git(projectDir: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: projectDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Where a repository is standing: the commit, and the branch it is standing on (absent when HEAD is detached). */
export interface Position {
  head: string;
  ref: string | undefined;
}

/**
 * Where the project directory is standing, or undefined when there is nothing
 * to compare against later -- no repository, no git, or a repository with no
 * commits yet. Read once at the start of a Turn; the whole measurement is
 * skipped when this is undefined.
 *
 * The branch is read alongside the commit because the commit alone cannot
 * tell a Turn's own work from a branch switch onto work that was already
 * there.
 */
export async function readPosition(projectDir: string): Promise<Position | undefined> {
  const head = await git(projectDir, ["rev-parse", "HEAD"]);
  if (!head) return undefined;
  return { head, ref: await git(projectDir, ["symbolic-ref", "--quiet", "HEAD"]) };
}

/**
 * What the Turn committed, or undefined when there is nothing to report.
 *
 * Undefined covers the ordinary cases: no starting position, HEAD never moved
 * (the overwhelmingly common one -- most Turns commit nothing), HEAD moved
 * *sideways*, or a diff that could not be read.
 *
 * Sideways is why this is more than a diff. A Turn that checks out another
 * branch, resets, or rebases leaves `before..after` describing work the Turn
 * did not do -- a wrong number, in a direction no reader could detect. Two
 * things must both hold for the range to mean what it says: the Turn ended on
 * the branch it started on, and the starting commit is still an ancestor of
 * where it ended. Reporting nothing understates the total; reporting a
 * sideways range would corrupt it.
 */
export async function measureContribution(
  projectDir: string,
  before: Position | undefined,
): Promise<Contribution | undefined> {
  if (!before) return undefined;

  const after = await readPosition(projectDir);
  if (!after || after.head === before.head) return undefined;
  if (after.ref !== before.ref) return undefined;

  const ancestry = await git(projectDir, [
    "merge-base",
    "--is-ancestor",
    before.head,
    after.head,
  ]);
  // Non-zero exit (which `git` turns into undefined) means the starting commit
  // is no longer in the history HEAD sits on: history was rewritten under it.
  if (ancestry === undefined) return undefined;

  const numstat = await git(projectDir, [
    "diff",
    "--numstat",
    `${before.head}..${after.head}`,
  ]);
  if (numstat === undefined) return undefined;

  let added = 0;
  let deleted = 0;
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [a, d] = line.split("\t");
    // A binary file reports "-\t-": it changed, but not in lines. Counting it
    // as zero is the only honest option for a line count.
    if (a === "-" || d === "-") continue;
    added += Number(a) || 0;
    deleted += Number(d) || 0;
  }

  return { ...(await attribution(projectDir)), added, deleted };
}

/**
 * Which repository to file the work under, derived from `origin`. Absent when
 * there is no origin -- the relay files those under its unattributed key
 * rather than dropping them, so the totals stay honest about what they don't
 * know.
 */
async function attribution(projectDir: string): Promise<{ host?: string; repo?: string }> {
  const url = await git(projectDir, ["remote", "get-url", "origin"]);
  if (!url) return {};
  return parseRemoteUrl(url) ?? {};
}

/**
 * The same attribution as {@link measureContribution}'s `host`/`repo`, joined
 * into the single `<host>#<org>/<repo>` key the relay's Contributions table
 * partitions by -- so a usage Event can carry the exact key the dashboard's
 * per-repo view will later match against, with no read-time join required.
 * Undefined when there is no origin, the same case `attribution` leaves
 * unattributed rather than dropping.
 */
export async function attributionKey(projectDir: string): Promise<string | undefined> {
  const { host, repo } = await attribution(projectDir);
  return host && repo ? `${host}#${repo}` : undefined;
}

/**
 * Splits a remote URL into host and "<org>/<repo>", covering both shapes git
 * uses: `git@host:org/repo.git` and `scheme://[credentials@]host/org/repo.git`.
 *
 * Credentials are never carried across. A clone URL routinely embeds a token
 * (this is how the agent image clones), and that token has no business being
 * sent to the relay and stored forever in a row nothing ever redacts.
 *
 * Exported for tests; nothing else should need it.
 */
export function parseRemoteUrl(url: string): { host: string; repo: string } | undefined {
  const trimmed = url.trim();

  // scp-like syntax, which is not a URL and so cannot be parsed as one.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return finish(scp[1], scp[2]);
  }

  try {
    const parsed = new URL(trimmed);
    return finish(parsed.hostname, parsed.pathname);
  } catch {
    return undefined;
  }
}

function finish(host: string, path: string): { host: string; repo: string } | undefined {
  const repo = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !repo) return undefined;
  return { host: host.toLowerCase(), repo };
}
