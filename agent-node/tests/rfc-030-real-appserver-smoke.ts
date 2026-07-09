// RFC-030 Phase 0 — real `codex app-server` smoke.
//
// Sanity-check that our client+bridge parse the actual 0.144.0 wire without
// relying on schema fixtures. This is NOT the full PoC gate (that needs a
// human TUI via `codex --remote`); it just:
//   1. spawns `codex app-server --listen ws://127.0.0.1:PORT`
//   2. waits for readyz
//   3. connects the client, runs `initialize`
//   4. logs the initialize response so schema drift shows up early
//
// Runs standalone: `bun tests/rfc-030-real-appserver-smoke.ts`
// Exit code 0 on success, 1 on failure. Time-boxed to 10s total.

import { spawn } from "child_process";
import { CodexAppServerClient } from "../src/runtime/codex-app-server-client";

async function main() {
  const port = 24500 + Math.floor(Math.random() * 200);
  const url = `ws://127.0.0.1:${port}`;
  console.log(`[smoke] starting codex app-server on ${url}`);

  const proc = spawn("codex", ["app-server", "--listen", url], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (d) => process.stdout.write(`[app-server stdout] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[app-server stderr] ${d}`));

  try {
    // Poll readyz for up to 5s.
    const readyzUrl = `http://127.0.0.1:${port}/readyz`;
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(readyzUrl);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error(`app-server /readyz not reachable after 5s`);
    console.log("[smoke] app-server ready");

    const client = new CodexAppServerClient({ url });
    await client.connect();
    console.log("[smoke] client connected");

    // The bridge policy is to never respond to reverse requests. Attach a
    // watcher so if the server somehow sends one during initialize we log it
    // rather than silently drop.
    client.on("reverse_request", (rr) => {
      console.log("[smoke] observed reverse_request during handshake:", rr);
    });

    const resp = await client.request<Record<string, unknown>>(
      "initialize",
      {
        clientInfo: {
          name: "anet_codex_bridge",
          title: "Agent Network Codex Bridge",
          version: "0.1.0-phase0-smoke",
        },
      },
      3_000,
    );
    console.log("[smoke] initialize response:", JSON.stringify(resp, null, 2));

    // Best-effort: fire `initialized` notification (per RFC §7.2 handshake).
    client.notify("initialized", {});
    console.log("[smoke] initialized notification sent");

    // Try a thread/resume for a synthetic threadId — the server will likely
    // reject (unknown thread), and that's OK for smoke; we just need to see
    // that the error envelope round-trips.
    let threadResumeErrorSeen = false;
    try {
      const r = await client.request(
        "thread/resume",
        { threadId: "thr_smoke_nonexistent" },
        3_000,
      );
      console.log("[smoke] thread/resume ok (unexpected but harmless):", r);
    } catch (e) {
      threadResumeErrorSeen = true;
      const msg = (e as Error).message;
      console.log("[smoke] thread/resume error (expected):", msg);
      if (!msg.includes("thread/resume")) {
        throw new Error(`error envelope missing method context: ${msg}`);
      }
    }

    await client.close();
    console.log("[smoke] client closed");

    if (threadResumeErrorSeen) {
      console.log("[smoke] PASS — dispatch handled error envelope correctly");
    } else {
      console.log("[smoke] PASS — handshake completed");
    }
  } finally {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    // Give it 500ms to clean up, then hard-kill.
    await new Promise((r) => setTimeout(r, 500));
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

main().catch((e) => {
  console.error("[smoke] FAIL:", e);
  process.exit(1);
});
