import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";

import { fakeQuery } from "./fakeSdk";

/**
 * The connector's only door into the SDK's `query()`. Everything else imports
 * from here rather than the package directly, so tests can swap it.
 *
 * `CRC_FAKE_SDK` is read once at process startup -- set only by the e2e
 * harness, naming which scripted persona (see fakeSdk.ts) to replay instead of
 * spawning a real model-backed subprocess. Unset in every real deployment.
 */
export const query: typeof realQuery = process.env.CRC_FAKE_SDK
  ? fakeQuery(process.env.CRC_FAKE_SDK)
  : realQuery;
