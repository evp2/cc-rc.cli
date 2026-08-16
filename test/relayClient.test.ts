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

/**
 * Auto-compact submits through the same endpoint the phone uses, told apart
 * only by this header. A wrong header value would make the relay misattribute
 * the Command to the phone -- exactly the false-liveness bug this header
 * exists to avoid -- so this pins the request shape directly.
 */
test("postCommand marks itself as the connector, not the phone", async () => {
  const realFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url, init: init! };
    return new Response(JSON.stringify({ seq: "01ABC", created_at: "2026-01-01T00:00:00.000Z" }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const client = await RelayClient.resume("http://relay.test", "sess-1", "secret");
    const result = await client.postCommand("/compact");

    assert.equal(result.seq, "01ABC");
    assert.equal(captured?.url, "http://relay.test/sessions/sess-1/commands");
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers["X-Crc-Client"], "connector");
    assert.equal(headers["Authorization"], "Bearer secret");
    assert.deepEqual(JSON.parse(captured!.init.body as string), { text: "/compact" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
