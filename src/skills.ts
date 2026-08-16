import type { Options, SlashCommand } from "@anthropic-ai/claude-agent-sdk";

import { PERMISSION_MODE } from "./config";
import type { SkillInfo } from "./relay/client";
import { query } from "./sdk/client";

/**
 * Keeps only the skills the user installed -- project-scoped ones from
 * `<project>/.claude/skills` and user-scoped ones from `~/.claude/skills` --
 * and drops the ~15 bundled with Claude Code (dataviz, doctor, loop, ...),
 * rarely what you want from a phone. The SDK offers no better signal than the
 * " (project)" / " (user)" suffix it tags them with in `description`: the
 * bundled ones carry no suffix at all. (getContextUsage().skills has a
 * structured `source` field, but it reports only a subset of skills, so it
 * can't be used here without silently dropping the rest.)
 *
 * Intersecting with `initSkillNames` first excludes Local commands (e.g.
 * /usage) that supportedCommands() also lists but that run inside the CLI
 * without ever reaching the model -- selectLocalCommands below reports those
 * separately, as their own menu section.
 *
 * Fails open: if the suffix ever stops matching anything, an unfiltered menu
 * is a mild annoyance, but an empty one looks like the feature is broken.
 */
const SCOPE_SUFFIX = / \((?:project|user)\)$/;

export function selectSkills(
  commands: SlashCommand[],
  initSkillNames: string[],
): SkillInfo[] {
  const names = new Set(initSkillNames);
  const modelDriven = commands.filter((c) => names.has(c.name));
  const installed = modelDriven.filter((c) => SCOPE_SUFFIX.test(c.description));
  const chosen = installed.length > 0 ? installed : modelDriven;
  return chosen.map((c) => ({
    name: c.name,
    description: c.description.replace(SCOPE_SUFFIX, ""),
    argumentHint: c.argumentHint,
  }));
}

/**
 * Local commands: whatever supportedCommands() lists that is *not* in
 * initSkillNames -- the CLI built-ins (`/clear`, `/compact`, `/usage`, ...)
 * that resolve entirely inside the CLI and never reach the model, so they
 * never appear in a system:init message's skills[]. Reported alongside
 * Skills, in the same shape, as a separate list the phone renders as its own
 * menu section.
 */
export function selectLocalCommands(
  commands: SlashCommand[],
  initSkillNames: string[],
): SkillInfo[] {
  const names = new Set(initSkillNames);
  return commands
    .filter((c) => !names.has(c.name))
    .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
}

function probeOptions(
  cwd: string,
  env: Record<string, string | undefined>,
  abortController: AbortController,
): Options {
  return {
    permissionMode: PERMISSION_MODE,
    allowDangerouslySkipPermissions: true,
    cwd,
    env,
    abortController,
  };
}

/** Never yields, so supportedCommands() is guaranteed to spend nothing: the subprocess can structurally never receive a user message to act on. */
async function* neverYields() {
  await new Promise<never>(() => undefined);
}

/**
 * Two throwaway query() calls, spawned once at connector startup so the
 * phone's menu is populated before the first real turn.
 *
 * Split in two because the two facts come from different channels:
 * supportedCommands() resolves from the CLI's initialize response without
 * ever consuming the message stream (proven empirically: it resolves in
 * ~200ms even fed a prompt that never yields), but the init message's
 * skills[] names -- the only signal that distinguishes a model-driven
 * command from a locally-handled one -- only arrive on that stream, and a
 * never-yielding prompt never produces it. A plain string prompt does: the
 * system:init message arrives before the model is ever invoked, so breaking
 * on it and aborting immediately after spends nothing.
 */
export async function probeSkills(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<{ skills: SkillInfo[]; localCommands: SkillInfo[] }> {
  const [commands, initSkillNames] = await Promise.all([
    readSupportedCommands(cwd, env),
    readInitSkillNames(cwd, env),
  ]);
  return {
    skills: selectSkills(commands, initSkillNames),
    localCommands: selectLocalCommands(commands, initSkillNames),
  };
}

async function readSupportedCommands(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SlashCommand[]> {
  const abortController = new AbortController();
  const q = query({ prompt: neverYields(), options: probeOptions(cwd, env, abortController) });
  try {
    return await q.supportedCommands();
  } finally {
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }
}

async function readInitSkillNames(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const abortController = new AbortController();
  const q = query({
    prompt: "(connector startup probe -- do not act on this)",
    options: probeOptions(cwd, env, abortController),
  });
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        return message.skills ?? [];
      }
    }
    return [];
  } finally {
    abortController.abort();
    try {
      await q.return?.();
    } catch {
      // Best-effort teardown of a probe subprocess we are discarding anyway.
    }
  }
}
