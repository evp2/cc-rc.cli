import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  measureContribution,
  parseRemoteUrl,
  readPosition,
} from "../src/session/contribution.ts";

/**
 * Driven against real repositories in temp directories rather than a faked
 * git. What is being pinned here is what git actually reports for a branch
 * switch, an empty repo and a binary file -- exactly the answers a double
 * would have had to assume.
 */
function run(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

/** A repository with one commit, optionally carrying an `origin`. */
function makeRepo(opts: { origin?: string; empty?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-contrib-"));
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "test@example.invalid");
  run(dir, "config", "user.name", "Test");
  if (opts.origin) run(dir, "remote", "add", "origin", opts.origin);
  if (!opts.empty) {
    writeFileSync(join(dir, "README.md"), "start\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "initial");
  }
  return dir;
}

function commit(dir: string, file: string, contents: string, message = "work"): void {
  writeFileSync(join(dir, file), contents);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", message);
}

test("what a turn committed is counted, added and deleted kept apart", async () => {
  const dir = makeRepo({ origin: "git@github.com:acme/widgets.git" });
  const before = await readPosition(dir);

  // Three lines added in a new file, and the one line of README.md replaced:
  // one added, one deleted.
  commit(dir, "added.txt", "a\nb\nc\n");
  commit(dir, "README.md", "restarted\n");

  const contribution = await measureContribution(dir, before);

  assert.deepEqual(contribution, {
    host: "github.com",
    repo: "acme/widgets",
    added: 4,
    deleted: 1,
  });
});

test("a turn that committed nothing reports nothing", async () => {
  const dir = makeRepo();
  const before = await readPosition(dir);

  // Written but never committed: the working tree moved, the history did not.
  writeFileSync(join(dir, "scratch.txt"), "not committed\n");

  assert.equal(await measureContribution(dir, before), undefined);
});

test("a branch switched mid-turn is skipped rather than mismeasured", async () => {
  const dir = makeRepo();
  const before = await readPosition(dir);
  commit(dir, "on-main.txt", "main work\n");

  // A sideways move. The starting commit is still an ancestor here -- the new
  // branch was cut from it -- so ancestry alone would have accepted a range
  // that silently drops the work done on main. The branch check is what
  // catches it.
  run(dir, "checkout", "-q", "-b", "sidetrack", before!.head);
  commit(dir, "elsewhere.txt", "different work entirely\n");

  assert.equal(await measureContribution(dir, before), undefined);
});

test("a reset back behind the starting commit is skipped too", async () => {
  const dir = makeRepo();
  commit(dir, "one.txt", "one\n");
  const before = await readPosition(dir);
  run(dir, "reset", "-q", "--hard", "HEAD~1");

  assert.equal(await measureContribution(dir, before), undefined);
});

test("a directory that is not a repository is invisible, not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crc-contrib-plain-"));

  assert.equal(await readPosition(dir), undefined);
  // The starting commit is what the whole measurement hangs off; without one
  // there is nothing to compare and nothing to report.
  assert.equal(await measureContribution(dir, undefined), undefined);
});

test("a repository with no commits yet has no starting point", async () => {
  const dir = makeRepo({ empty: true });

  assert.equal(await readPosition(dir), undefined);
});

test("a repository with no origin still counts, unattributed", async () => {
  const dir = makeRepo();
  const before = await readPosition(dir);
  commit(dir, "solo.txt", "one\ntwo\n");

  const contribution = await measureContribution(dir, before);

  assert.deepEqual(contribution, { added: 2, deleted: 0 });
});

test("a binary file counts as no lines rather than NaN", async () => {
  const dir = makeRepo();
  const before = await readPosition(dir);
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
  writeFileSync(join(dir, "text.txt"), "one\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "binary and text");

  const contribution = await measureContribution(dir, before);

  assert.deepEqual(contribution, { added: 1, deleted: 0 });
});

test("remote URLs resolve to a host and org/repo, in either syntax", () => {
  assert.deepEqual(parseRemoteUrl("git@github.com:acme/widgets.git"), {
    host: "github.com",
    repo: "acme/widgets",
  });
  assert.deepEqual(parseRemoteUrl("https://github.com/acme/widgets.git"), {
    host: "github.com",
    repo: "acme/widgets",
  });
  assert.deepEqual(parseRemoteUrl("https://github.com/acme/widgets"), {
    host: "github.com",
    repo: "acme/widgets",
  });
  assert.deepEqual(parseRemoteUrl("ssh://git@gitlab.example.com:2222/group/sub/proj.git"), {
    host: "gitlab.example.com",
    repo: "group/sub/proj",
  });
  assert.deepEqual(parseRemoteUrl("HTTPS://GitHub.com/Acme/Widgets.git"), {
    host: "github.com",
    repo: "Acme/Widgets",
  });
  assert.equal(parseRemoteUrl("not a url"), undefined);
});

test("a token embedded in the clone URL is never carried into the report", () => {
  // How the agent image clones. The token must not reach the relay, which
  // stores what it is sent forever and redacts nothing.
  const parsed = parseRemoteUrl("https://x-access-token:ghp_secret@github.com/acme/widgets.git");

  assert.deepEqual(parsed, { host: "github.com", repo: "acme/widgets" });
  assert.ok(!JSON.stringify(parsed).includes("ghp_secret"));
});
