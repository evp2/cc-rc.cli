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

import { AsyncQueue, takeOne, textOf } from "./asyncQueue";

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

/** What every fake persona's `getContextUsage()` reports. */
const FAKE_CONTEXT_PERCENTAGE = 42;

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
    // 0.01 rather than 0.0001: the client's divider now shows cost_usd to only
    // 2 decimals, and 0.0001 rounds to "$0.00" there, which made
    // smoke.spec.ts's telemetry.costUsd > 0 assertion fail.
    total_cost_usd: 0.01,
    // Real counts, not an empty object: the relay rejects a `usage` event
    // missing any of them, and a rejected batch is retried forever, so an
    // empty usage here wedges the whole event stream rather than just losing
    // the usage row.
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
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

/** Resolves once `signal` aborts -- already-aborted resolves immediately. */
function onAbort(signal: AbortSignal): Promise<{ kind: "abort" }> {
  if (signal.aborted) return Promise.resolve({ kind: "abort" });
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
  });
}

// Comfortably longer than the connector's steer-poll interval (1s) plus the
// round trip a test needs to *observe* this sub-turn has started before it
// can act -- the relay flush (750ms) and the phone's own event poll (2s) sit
// between "the persona is paused" and "a test script can tell." Too short a
// window here doesn't fail loudly; it just makes a Steer arrive a moment too
// late and silently exercises the un-steered path instead.
const STEER_PAUSE_MS = 8000;

/**
 * Waits, after one simulated tool call, for whichever comes first: a message
 * streamed in via the mailbox (a Steer landing), the turn's own abort signal
 * (Stop), or the pause simply timing out (nothing was sent). Mirrors what the
 * real SDK's `canUseTool`/`streamInput` seam gives the connector -- parked
 * here is exactly a Turn "genuinely working" that a Steer can reach.
 */
async function pauseForSteer(
  mailbox: AsyncQueue<SDKUserMessage>,
  signal: AbortSignal | undefined,
): Promise<{ kind: "abort" } | { kind: "timeout" } | { kind: "steer"; message: SDKUserMessage }> {
  const steered = takeOne(mailbox).then((message) =>
    message ? ({ kind: "steer", message } as const) : undefined,
  );
  const timedOut = sleep(STEER_PAUSE_MS).then(() => ({ kind: "timeout" as const }));
  const racers = signal ? [steered, timedOut, onAbort(signal)] : [steered, timedOut];
  const result = await Promise.race(racers);
  if (!result) throw new Error("mailbox closed without a message");
  return result;
}

// The first sub-turn (the original Command's own plan) works through this
// many steps before finishing on its own if nothing Steers it -- enough to
// prove a Steer mid-sequence really does abandon a step that would otherwise
// have run (never-emitted "step-2" text is what the specs check for), without
// multiplying by STEER_PAUSE_MS into an unreasonably long wait for the specs
// that let one run unsteered to completion. A sub-turn replying to an
// already-accepted Steer gets only one step: enough to be genuinely "working"
// and reachable by a further Steer, without making every hand-back test wait
// out a multi-step cool-down it has no reason to care about.
const FIRST_SUBTURN_STEPS = 2;
const REPLY_SUBTURN_STEPS = 1;

/**
 * The Turn's simulated work, as a chain of sub-turns: the original Command's
 * plan, and then one more per Steer accepted, each pausing after every step
 * long enough for the next Steer to land. This is the persona-side half of
 * the hand-back race -- the generator, not a timer, decides exactly when the
 * Turn is far enough along to accept one.
 *
 * A Steer landing truncates the current sub-turn at that tool-call boundary
 * (no further steps in its plan run) and starts a fresh one announcing it,
 * so a conversation can Steer more than once. A sub-turn that exhausts its
 * steps with nothing sent finishes the Turn normally. Stop ends the
 * generator outright, mid-pause or mid-confirm.
 */
async function* subTurnLoop(
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
  opts: {
    /**
     * Delays between a Steer landing and this generator confirming it with a
     * fresh `system:init` -- widening the connector's real, normally
     * sub-millisecond window between streaming a Steer in and the SDK
     * confirming it accepted, so a test can land Stop inside it reliably and
     * exercise the discard-by-Stop path deterministically rather than racing
     * real timing.
     */
    confirmDelayMs?: number;
    /**
     * Starts the Steer's sub-turn with a fresh `system:init` and no `result`
     * for the sub-turn it truncated -- the interrupt ordering, where the
     * Steer is confirmed before (and instead of) the outcome of what it cut
     * off. Every other persona here reports the truncated sub-turn's `result`
     * first, which is the only ordering the connector's claim accounting was
     * ever exercised against.
     */
    initBeforeResult?: boolean;
  } = {},
): AsyncGenerator<SDKMessage, void> {
  const signal = options.abortController?.signal;
  // Set once a Steer is accepted, and announced as the first thing the next
  // sub-turn says -- reset to the reply allowance from then on.
  let announce: SDKUserMessage | undefined;
  let maxSteps = FIRST_SUBTURN_STEPS;

  for (;;) {
    if (announce) {
      yield assistantText(`steered: ${textOf(announce)}`);
      announce = undefined;
      maxSteps = REPLY_SUBTURN_STEPS;
    }

    let steered: SDKUserMessage | undefined;
    for (let step = 1; step <= maxSteps && !steered; step++) {
      const toolUseId = `toolu_${randomUUID()}`;
      yield assistantToolUse(toolUseId, "Bash", { command: `echo step-${step}` });
      yield userToolResult(toolUseId, `step-${step}`);

      const outcome = await pauseForSteer(mailbox, signal);
      if (outcome.kind === "abort") return;
      if (outcome.kind === "steer") steered = outcome.message;
    }

    if (!steered) {
      yield assistantText("finished without being steered further");
      yield resultSuccess();
      return;
    }

    if (opts.confirmDelayMs) {
      // Observable the instant the Steer is received, before the artificial
      // hold -- a test exercising the discard-by-Stop race waits for this
      // rather than guessing when the hold started from wall-clock alone.
      yield assistantText("holding before confirm");
      await sleep(opts.confirmDelayMs);
    }
    if (signal?.aborted) return;

    // This sub-turn ends, having said nothing further, and the Steer's own
    // sub-turn begins in the same query. Under initBeforeResult the truncated
    // one is simply cut off: the `init` is all the connector ever hears about
    // it, so a Command released only by its own `result` is never released.
    if (!opts.initBeforeResult) yield resultSuccess();
    yield systemInit();
    announce = steered;
    // Loop back: the reply about to be announced is itself steppable and
    // steerable, not an instant, un-interruptible finish.
  }
}

/** A Turn that works through a sequence of steps a Steer can land on. See {@link subTurnLoop}. */
async function* steeringPersona(
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  yield* subTurnLoop(options, mailbox);
}

/**
 * Takes a Steer and then ends the query without ever confirming it with a
 * fresh `system:init` -- the shape every other steering persona is careful
 * never to produce, and the one the real SDK produces routinely.
 *
 * A Local command (`/compact`) streamed in mid-Turn is the guaranteed case:
 * the CLI handles it itself and reports a `compact_boundary` and a `result`,
 * never a fresh `init`, so the Steer the connector is holding is never
 * confirmed and the query simply ends. A `streamInput` that rejects reaches
 * the same state by a different road.
 */
async function* steeringNoConfirmPersona(
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  const signal = options.abortController?.signal;
  for (let step = 1; step <= FIRST_SUBTURN_STEPS; step++) {
    const toolUseId = `toolu_${randomUUID()}`;
    yield assistantToolUse(toolUseId, "Bash", { command: `echo step-${step}` });
    yield userToolResult(toolUseId, `step-${step}`);
    const outcome = await pauseForSteer(mailbox, signal);
    if (outcome.kind === "abort") return;
    if (outcome.kind === "steer") {
      yield assistantText("absorbed the steer without starting a new sub-turn");
      yield resultSuccess();
      return;
    }
  }
  yield assistantText("finished without being steered further");
  yield resultSuccess();
}

/**
 * Confirms a Steer with a fresh `system:init` before the sub-turn it
 * truncated has reported any `result` -- the interrupt ordering. The
 * connector must release the superseded Command on the `init` itself, since
 * nothing else ever will; getting this wrong holds it for the life of the
 * process and leaves the phone's brake and Thinking indicator stuck on
 * against a Turn that finished, which is invisible in the transcript.
 */
async function* steeringInitFirstPersona(
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  yield* subTurnLoop(options, mailbox, { initBeforeResult: true });
}

/** Like {@link steeringPersona}, but see `confirmDelayMs` on {@link subTurnLoop}. */
async function* steeringSlowConfirmPersona(
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  // Long enough that a test can wait to *observe* "holding before confirm"
  // rendered on the phone -- itself a relay flush (750ms) plus an event poll
  // (2s) after the persona actually said it -- and still click Stop with
  // room to spare before this window closes on its own.
  yield* subTurnLoop(options, mailbox, { confirmDelayMs: 6000 });
}

/**
 * Asks a Question first, the way askUserQuestionPersona does, then -- once
 * Answered -- enters {@link subTurnLoop}. Exercises "a Command sent during
 * the Question steers the Turn normally once the Answer releases it": the
 * Question and the step loop are two distinct phases of one Turn, and only
 * the second one ever reads the mailbox.
 */
async function* steeringWithQuestionPersona(
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
  yield systemInit();
  const toolUseId = `toolu_${randomUUID()}`;
  const input = {
    questions: [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Go ahead." }],
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

  if (result?.behavior !== "allow") {
    yield userToolResult(toolUseId, result?.message ?? "denied", true);
    yield resultSuccess();
    return;
  }
  yield userToolResult(toolUseId, JSON.stringify(result.updatedInput ?? {}));
  yield* subTurnLoop(options, mailbox);
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
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
  if (typeof prompt === "string") return dispatch(persona, prompt, options, mailbox);
  // Streaming-input mode (run.ts): the initial text is the first message on
  // the iterable rather than the prompt itself. Reading it is deferred inside
  // the generator so a query that is never iterated -- the skill-discovery
  // probe's never-yielding prompt, whose supportedCommands() resolves
  // independently of the message stream -- never runs this at all.
  return (async function* () {
    const first = await takeOne(prompt);
    if (first === undefined) return;
    yield* dispatch(persona, textOf(first), options, mailbox);
  })();
}

/**
 * `mailbox` carries whatever a live Turn's `streamInput` injects mid-flight
 * (the steering seam, from here on). No current persona reads it -- this is
 * the "a persona that ignores the mailbox behaves exactly as it does today"
 * case the plumbing exists to support without a behaviour change.
 */
function dispatch(
  persona: string,
  prompt: string,
  options: Options,
  mailbox: AsyncQueue<SDKUserMessage>,
): AsyncGenerator<SDKMessage, void> {
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
    case "steering":
      return steeringPersona(options, mailbox);
    case "steering-with-question":
      return steeringWithQuestionPersona(options, mailbox);
    case "steering-slow-confirm":
      return steeringSlowConfirmPersona(options, mailbox);
    case "steering-no-confirm":
      return steeringNoConfirmPersona(options, mailbox);
    case "steering-init-first":
      return steeringInitFirstPersona(options, mailbox);
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
  steering: [],
  "steering-with-question": [],
  "steering-slow-confirm": [],
  "steering-no-confirm": [],
  "steering-init-first": [],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds a `Query`-shaped object around a plain async generator, adding the handful of methods the connector actually calls. */
function buildQuery(
  gen: AsyncGenerator<SDKMessage, void>,
  commands: SlashCommand[],
  mailbox: AsyncQueue<SDKUserMessage>,
): Query {
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
    // Mirrors the real SDK's Query.streamInput: the connector's turn-scoped
    // poller (the steering seam) calls this to inject a mid-turn Command.
    // Draining into the mailbox rather than yielding straight into `gen`
    // matches the real shape -- input and output are separate streams -- and
    // leaves it up to the persona whether and when to react.
    streamInput: async (stream: AsyncIterable<SDKUserMessage>): Promise<void> => {
      for await (const message of stream) mailbox.push(message);
    },
    // Fixed rather than persona-specific: no scripted turn currently needs a
    // particular reading, only that one is available for the phone to render.
    getContextUsage: async () => ({ percentage: FAKE_CONTEXT_PERCENTAGE }),
  };
  return q as unknown as Query;
}

export function fakeQuery(persona: string): typeof realQuery {
  return ({ prompt, options }) => {
    const mailbox = new AsyncQueue<SDKUserMessage>();
    const gen = scriptFor(persona, prompt, options ?? {}, mailbox);
    return buildQuery(gen, FAKE_SUPPORTED_COMMANDS[persona] ?? [], mailbox);
  };
}
