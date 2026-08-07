import assert from "node:assert/strict";
import { test } from "node:test";

import { RelayClient } from "../src/relay/client.ts";

/**
 * Observed in production: a relay request whose connection hangs (no
 * response, no error -- a stuck socket) blocked the connector's single,
 * sequential main loop forever, because nothing bounded the fetch. This
 * proves the bound directly against the real RelayClient, with the global
 * fetch faked to hang exactly that way, rather than against a double that
 * could not have caught this.
 */
test("a hung relay request times out instead of blocking forever", async () => {
  const realFetch = globalThis.fetch;
  // Never resolves or rejects on its own -- the only way out is the signal.
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;

  try {
    await assert.rejects(
      RelayClient.resume("http://example.invalid", "sess-1", "secret", 20),
      /timeout/i,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
