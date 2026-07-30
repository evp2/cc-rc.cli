import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  query as realQuery,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Test-only replacements for the SDK's `query()`, selected by `CRC_FAKE_SDK`
 * (see sdkClient.ts). Each persona replays a fixed, scripted `SDKMessage`
 * sequence instead of spawning a real subprocess, so the e2e tests built
 * against them spend no model call.
 *
 * Messages carry only the fields the connector's own code (sdkBridge.ts,
 * run.ts, skills.ts) actually reads -- not a faithful reproduction of every
 * field the real SDK emits, hence the `unknown` casts throughout.
 *
 * For the Question persona, canUseTool is invoked exactly as the real SDK
 * would invoke it, so what's under test is the connector's own plumbing.
 */

const FAKE_SESSION_ID = "fake-sdk-session";

function systemInit(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    claude_code_version: "0.0.0-fake",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "fake-model",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function assistantText(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      model: "fake-model",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {},
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function assistantToolUse(toolUseId: string, name: string, input: unknown): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      model: "fake-model",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
      stop_reason: null,
      stop_sequence: null,
      usage: {},
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function userToolResult(toolUseId: string, content: string, isError = false): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function resultSuccess(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    // 10ms used to round to "0.0s" in the client's (duration_ms/1000).toFixed(1)
    // divider text, which smoke.spec.ts's telemetry.seconds > 0 assertion then
    // parsed as 0 and failed.
    duration_ms: 250,
    duration_api_ms: 250,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: null,
    total_cost_usd: 0.0001,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function localCommandOutput(content: string): SDKMessage {
  return {
    type: "system",
    subtype: "local_command_output",
    content,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function conversationReset(): SDKMessage {
  return {
    type: "conversation_reset",
    new_conversation_id: randomUUID(),
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function compactBoundary(preTokens: number, postTokens: number): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: preTokens, post_tokens: postTokens, duration_ms: 500 },
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function taskStarted(
  taskId: string,
  toolUseId: string,
  description: string,
  opts: { taskType?: string; skipTranscript?: boolean } = {},
): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    task_type: opts.taskType,
    skip_transcript: opts.skipTranscript,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function taskNotification(
  taskId: string,
  toolUseId: string,
  status: "completed" | "failed" | "stopped",
  summary: string,
  opts: { skipTranscript?: boolean } = {},
): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    output_file: `/tmp/${taskId}.log`,
    summary,
    usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1234 },
    skip_transcript: opts.skipTranscript,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

function backgroundTasksChanged(
  tasks: { task_id: string; task_type: string; description: string }[],
): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks,
    uuid: randomUUID(),
    session_id: FAKE_SESSION_ID,
  } as unknown as SDKMessage;
}

/**
 * Spawns one background shell task and yields the turn's own `result`
 * *before* the task settles -- the connector's run loop must keep draining
 * this same generator past `result` to still catch the settle, which is the
 * spec's flagged risk (a Background task can outlive the turn that spawned
 * it). Exercises the whole connector->relay->phone path -- translation in
 * sdkBridge.ts, the events pipeline, and the phone's card + tray -- with no
 * model. The spawning tool_use is emitted first so the started event's
 * tool_use_id has a real call to anchor to.
 */
async function* backgroundTasksPersona(): AsyncGenerator<SDKMessage, void> {
  yield systemInit();

  const toolUseId = `toolu_${randomUUID()}`;
  const taskId = `task_${randomUUID()}`;
  const description = "sleep 30 && echo done";

  yield assistantToolUse(toolUseId, "Bash", { command: description, run_in_background: true });
  yield userToolResult(toolUseId, "Command running in the background.");
  yield taskStarted(taskId, toolUseId, description, { taskType: "shell" });
  yield backgroundTasksChanged([{ task_id: taskId, task_type: "shell", description }]);
  yield assistantText("Kicked off a background job.");
  // The turn itself is done -- the phone's composer unlocks now -- while the
  // background task it spawned is still running.
  yield resultSuccess();

  // Comfortably longer than the phone's 2s event poll, so the task is
  // observably "running" on the phone for at least one poll cycle rather than
  // started and settled collapsing into a single batch the phone never catches.
  await sleep(6000);

  yield taskNotification(taskId, toolUseId, "completed", "done");
  yield backgroundTasksChanged([]);
}

/** Replays `/clear` and `/compact` output; anything else gets a plain reply. */
async function* localCommandsPersona(prompt: string): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  const text = prompt.trim();
  if (text === "/clear") {
    yield localCommandOutput("Conversation cleared.");
    yield conversationReset();
  } else if (text === "/compact") {
    yield localCommandOutput("Compacted the conversation.");
    yield compactBoundary(12000, 3000);
  } else {
    yield assistantText("ok");
  }
  yield resultSuccess();
}

/**
 * Calls AskUserQuestion once, the way Grill Me would, then waits on
 * `canUseTool` exactly as the real SDK does: awaiting its promise before
 * emitting the tool_result and continuing the turn. Any prompt triggers it --
 * these tests don't exercise the model's own judgement about when to ask.
 */
async function* askUserQuestionPersona(
  options: Options,
): AsyncGenerator<SDKMessage, void> {
  yield systemInit();

  const toolUseId = `toolu_${randomUUID()}`;
  const input = {
    questions: [
      {
        question: "Which approach should we take?",
        header: "Approach",
        options: [
          { label: "Option A", description: "The first way." },
          { label: "Option B", description: "The second way." },
        ],
        multiSelect: false,
      },
    ],
  };
  yield assistantToolUse(toolUseId, "AskUserQuestion", input);

  const signal = options.abortController?.signal ?? new AbortController().signal;
  const result: PermissionResult | null = options.canUseTool
    ? await options.canUseTool("AskUserQuestion", input, {
        signal,
        toolUseID: toolUseId,
        requestId: `fake-req-${toolUseId}`,
      })
    : null;

  if (signal.aborted) return;

  if (result?.behavior === "allow") {
    yield userToolResult(toolUseId, JSON.stringify(result.updatedInput ?? {}));
    yield assistantText("Thanks, got it.");
  } else {
    yield userToolResult(toolUseId, result?.message ?? "denied", true);
  }
  yield resultSuccess();
}

/**
 * Stands in for smoke.spec.ts's real turns: writes/appends to e2e-proof.txt
 * under `options.cwd` itself (the real SDK's subprocess does this, not the
 * connector), then reports it the same way the model would -- via a tool_use
 * the transcript can render, not just a text claim.
 */
async function* smokePersona(prompt: string, options: Options): AsyncGenerator<SDKMessage, void> {
  yield systemInit();

  // No fallback: run.ts always sets cwd to config.projectDir, so a missing
  // cwd here means a caller changed that contract, and should fail loudly
  // rather than silently write into the connector process's own directory.
  if (!options.cwd) throw new Error("smokePersona requires options.cwd");
  const filePath = join(options.cwd, "e2e-proof.txt");
  const toolUseId = `toolu_${randomUUID()}`;

  if (prompt.includes("Create a file named e2e-proof.txt")) {
    await writeFile(filePath, "e2e ok\n", "utf-8");
    yield assistantToolUse(toolUseId, "Write", { file_path: filePath, content: "e2e ok\n" });
    yield userToolResult(toolUseId, "File created successfully.");
    yield assistantText("DONE");
  } else if (prompt.includes("Append a second line")) {
    await appendFile(filePath, "turn two ok\n", "utf-8");
    yield assistantToolUse(toolUseId, "Edit", {
      file_path: filePath,
      old_string: "e2e ok\n",
      new_string: "e2e ok\nturn two ok\n",
    });
    yield userToolResult(toolUseId, "File updated successfully.");
    yield assistantText("done");
  } else {
    yield assistantText("ok");
  }
  yield resultSuccess();
}

/**
 * Stands in for event-batching.spec.ts's long multi-tool turn: 30 Bash
 * tool_use/tool_result pairs plus the surrounding init/text/result messages,
 * which is what the test needs to exceed the relay's 25-event batch cap --
 * not anything about a real command actually running. Any prompt triggers
 * it, the same as askUserQuestionPersona.
 */
async function* multiToolTurnPersona(): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  for (let n = 1; n <= 30; n++) {
    const toolUseId = `toolu_${randomUUID()}`;
    yield assistantToolUse(toolUseId, "Bash", { command: `echo batch-${n}` });
    yield userToolResult(toolUseId, `batch-${n}`);
  }
  yield assistantText("BATCHDONE");
  yield resultSuccess();
}

function scriptFor(
  persona: string,
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options,
): AsyncGenerator<SDKMessage, void> {
  if (typeof prompt !== "string") {
    // The skill-discovery probe's never-yielding prompt: supportedCommands()
    // resolves independently of the message stream, so nothing needs to be
    // emitted here.
    return (async function* () {})();
  }
  switch (persona) {
    case "local-commands":
      return localCommandsPersona(prompt);
    case "ask-user-question":
      return askUserQuestionPersona(options);
    case "smoke":
      return smokePersona(prompt, options);
    case "multi-tool-turn":
      return multiToolTurnPersona();
    case "background-tasks":
      return backgroundTasksPersona();
    default:
      throw new Error(`Unknown CRC_FAKE_SDK persona: '${persona}'`);
  }
}

/**
 * What supportedCommands() reports for each persona -- read by skills.ts at
 * connector startup, independent of the message stream (see probeSkills).
 * Every entry here has no matching name in any system:init's skills[] (always
 * empty in this fake), so selectLocalCommands treats all of them as Local
 * commands rather than model-driven Skills -- which is what the local-commands
 * persona needs to exercise the menu's Local commands section.
 */
const FAKE_SUPPORTED_COMMANDS: Record<string, SlashCommand[]> = {
  "local-commands": [
    { name: "clear", description: "Clear conversation history", argumentHint: "" },
    { name: "compact", description: "Compact the conversation", argumentHint: "" },
  ],
  "ask-user-question": [],
  smoke: [],
  "multi-tool-turn": [],
  "background-tasks": [],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a `Query`-shaped object around a plain async generator, adding the handful of methods the connector actually calls. */
function buildQuery(gen: AsyncGenerator<SDKMessage, void>, commands: SlashCommand[]): Query {
  const q = {
    [Symbol.asyncIterator]() {
      return q;
    },
    next: (...args: Parameters<AsyncGenerator<SDKMessage, void>["next"]>) => gen.next(...args),
    return: (value?: void) => gen.return(value),
    throw: (e?: unknown) => gen.throw(e),
    supportedCommands: async (): Promise<SlashCommand[]> => commands,
    // The connector's kill-watcher calls this when the phone asks to Kill a
    // Background task. The fake persona settles its own tasks on a timer, so
    // this only needs to not throw -- the real SDK is what actually stops one.
    stopTask: async (): Promise<void> => undefined,
  };
  return q as unknown as Query;
}

export function fakeQuery(persona: string): typeof realQuery {
  return ({ prompt, options }) =>
    buildQuery(scriptFor(persona, prompt, options ?? {}), FAKE_SUPPORTED_COMMANDS[persona] ?? []);
}
