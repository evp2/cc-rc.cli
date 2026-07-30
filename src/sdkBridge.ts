import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { EventInput } from "./relayClient";

/**
 * Maps one streamed SDKMessage to zero or more relay output events. A single
 * assistant message can contain multiple content blocks (text + several
 * tool_use calls), so this returns an array rather than a single event.
 */
export function mapSdkMessage(message: SDKMessage): EventInput[] {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        return [
          {
            type: "status",
            text: `session started (model ${message.model}, permission ${message.permissionMode})`,
          },
        ];
      }
      if (message.subtype === "local_command_output") {
        return [{ type: "status", text: message.content }];
      }
      if (message.subtype === "compact_boundary") {
        const { pre_tokens, post_tokens } = message.compact_metadata;
        return [
          {
            type: "status",
            text:
              post_tokens === undefined
                ? `compacted (from ${pre_tokens} tokens)`
                : `compacted (${pre_tokens} → ${post_tokens} tokens)`,
          },
        ];
      }
      // Background-task lifecycle -- work Claude spawned that runs on its own
      // and may outlive the turn (a `run_in_background` Bash, a Task subagent).
      // The connector used to drop all of these; now each becomes an Event the
      // phone renders as an inline card and a live tray.
      if (message.subtype === "task_started") {
        return [
          {
            type: "background_task_started",
            task_id: message.task_id,
            tool_use_id: message.tool_use_id,
            text: message.description,
            task_type: message.task_type ?? (message.subagent_type ? "subagent" : undefined),
            is_ambient: !!message.skip_transcript,
          },
        ];
      }
      if (message.subtype === "task_notification") {
        return [
          {
            type: "background_task_settled",
            task_id: message.task_id,
            tool_use_id: message.tool_use_id,
            task_status: message.status,
            text: message.summary,
            is_ambient: !!message.skip_transcript,
            duration_ms: message.usage?.duration_ms,
          },
        ];
      }
      // The level signal for the tray: the full set of currently-live tasks
      // with REPLACE semantics. Passed through as-is so the phone can swap its
      // set on each payload rather than pairing started/settled edges.
      if (message.subtype === "background_tasks_changed") {
        return [
          {
            type: "background_tasks_changed",
            tasks: message.tasks.map((t) => ({
              task_id: t.task_id,
              task_type: t.task_type,
              description: t.description,
            })),
          },
        ];
      }
      return [];

    // Emitted by /clear, plan-mode exit, and fresh-session flows -- not a
    // `system` message despite the family resemblance.
    case "conversation_reset":
      return [{ type: "status", text: "conversation cleared" }];

    case "assistant": {
      const events: EventInput[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          events.push({ type: "assistant_text", text: block.text });
        } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          // Surfaced as its own event type rather than an ordinary tool_use:
          // the phone renders a picker for this one, not a collapsed
          // accordion of raw JSON. canUseTool (run.ts) holds the matching
          // tool call open until an Answer resolves it.
          events.push({
            type: "question",
            tool_use_id: block.id,
            tool_input: block.input,
          });
        } else if (block.type === "tool_use") {
          events.push({
            type: "tool_use",
            tool_name: block.name,
            tool_input: block.input,
            tool_use_id: block.id,
          });
        }
      }
      return events;
    }

    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return [];
      const events: EventInput[] = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            text: stringifyToolResultContent(block.content),
            is_error: !!block.is_error,
          });
        }
      }
      return events;
    }

    case "result":
      if (message.subtype === "success") {
        return [
          {
            type: "turn_complete",
            cost_usd: message.total_cost_usd,
            duration_ms: message.duration_ms,
          },
        ];
      }
      return [
        {
          type: "error",
          text: `errors` in message && message.errors.length
            ? message.errors.join("; ")
            : message.subtype,
          is_error: true,
        },
      ];

    default:
      return [];
  }
}

/**
 * How long a gap between turns makes the session banner worth repeating.
 * Someone returning to the tab after a break has scrolled past -- or never
 * saw -- the last one, and which model is answering is worth restating then.
 */
const BANNER_REPEAT_AFTER_MS = 60 * 60 * 1000;

/**
 * `mapSdkMessage` with the session banner deduplicated across turns.
 *
 * The SDK emits a fresh `system:init` for every `query()`, and the connector
 * runs one per turn, so mapping each message independently puts the same
 * "session started (model ..., permission ...)" line above every single reply.
 * It is worth reading when it changes -- a different model, a different
 * permission mode -- or after a long enough silence; in a continuous
 * conversation it is noise, and on a phone it costs a screenful.
 *
 * Stateful, so one mapper must be shared by every turn of a session. A
 * connector restart makes a new one and therefore re-announces once, which is
 * right: the phone may have reloaded and lost the transcript above.
 */
export function createSdkMessageMapper(
  now: () => number = Date.now,
): (message: SDKMessage) => EventInput[] {
  let lastBanner: string | undefined;
  let lastBannerAt = 0;

  return (message) => {
    const events = mapSdkMessage(message);
    if (message.type !== "system" || message.subtype !== "init") return events;

    const banner = events[0]?.text;
    const at = now();
    // Timestamped on every turn, not just announced ones, so the threshold
    // measures silence between turns rather than time since the last banner --
    // a session busy for hours stays quiet.
    const repeat = banner !== lastBanner || at - lastBannerAt >= BANNER_REPEAT_AFTER_MS;
    lastBanner = banner;
    lastBannerAt = at;
    return repeat ? events : [];
  };
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block),
      )
      .join("\n");
  }
  return JSON.stringify(content);
}
