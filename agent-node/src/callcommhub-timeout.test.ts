// #1357 — callCommHub's fetch must carry a per-request timeout.
//
// Node's fetch has NO default timeout on an established connection: a hub
// that accepts the POST but never finishes the response leaves the promise
// unsettled forever. The retry loop in callCommHub only advances after fetch
// settles, so that one call pins the caller with zero logs, zero alerts.
//
// cli.ts is a side-effecting entrypoint (it connects out on import), so the
// wiring is asserted against the source text, and the mechanism itself —
// AbortSignal.timeout aborts a hung fetch with a retryable error — is proven
// behaviorally against a real hung HTTP server.
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("#1357 callCommHub per-request timeout", () => {
  const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("cli.ts defines CALL_COMMHUB_TIMEOUT_MS", () => {
    expect(src).toMatch(/const CALL_COMMHUB_TIMEOUT_MS = \d[\d_]*;/);
  });

  test("callCommHub's fetch carries signal: AbortSignal.timeout(CALL_COMMHUB_TIMEOUT_MS)", () => {
    // Anchor inside the callCommHub function body, not anywhere in the file:
    // the assertion must fail if the signal is moved to some other fetch.
    const fnStart = src.indexOf("async function callCommHub(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart);
    const body = src.slice(fnStart, fnEnd);
    expect(body).toContain("signal: AbortSignal.timeout(CALL_COMMHUB_TIMEOUT_MS)");
  });

  test("AbortSignal.timeout aborts a hung fetch with a retryable (thrown) error", async () => {
    // A server that accepts the request and then goes silent — the exact
    // failure shape from the issue. Without a signal this fetch never settles.
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((req) => { req.socket.setTimeout(0); /* never respond */ });
    server.on("connection", (s) => sockets.add(s));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    try {
      const t0 = Date.now();
      let thrown: any;
      try {
        await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(150),
        });
      } catch (e) {
        thrown = e;
      }
      const elapsed = Date.now() - t0;
      // It settled (the whole point), promptly, and with an error the
      // callCommHub catch-branch treats as retryable (any non-CommHubError).
      expect(thrown).toBeDefined();
      expect(["TimeoutError", "AbortError"]).toContain(thrown.name);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
