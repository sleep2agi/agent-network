// #438 corrective — regression gate for the two boot-path failure modes:
//
//   1. import side effect: `import("./server.js")` must NOT bind any port.
//      Pre-corrective (7fa3ad35, when this module was still index.ts with
//      module-level `export const server = bootServer()`) this fails:
//      witnessed-red showed the probe port EADDRINUSE right after import.
//      The run-entry shim src/index.ts is the ONLY module whose import
//      boots — by design, documented there — and is deliberately not
//      imported anywhere in the test suite.
//   2. silent no-op double start: `startHub()` is single-shot and must
//      REJECT a second call observably — "I thought I started it but
//      nothing happened" is the same failure family as the
//      import.meta.main incident (#438 review).
//
// Test order inside this file matters: the no-side-effect probe must run
// BEFORE anything calls startHub in this process. bun executes tests in
// declaration order, and no other suite calls startHub.

import { describe, expect, test } from "bun:test";

const PROBE_PORT = 18500 + Math.floor(Math.random() * 500);

describe("#438 corrective — importing server.ts is side-effect-free", () => {
  test("importing server.js binds nothing (probe port stays free)", async () => {
    // Pin the module's default PORT to the probe so that IF an import
    // side effect ever regresses, it binds exactly the port we probe.
    process.env.PORT = process.env.PORT || String(PROBE_PORT);
    const probe = Number(process.env.PORT) || PROBE_PORT;
    await import("./server.js");
    // If import had booted a server, this bind would throw EADDRINUSE.
    let listener: any = null;
    expect(() => {
      listener = Bun.listen({ hostname: "127.0.0.1", port: probe, socket: { data() {} } });
    }).not.toThrow();
    listener?.stop?.(true);
  });
});

describe("#476 — import alone must let the process exit", () => {
  test("a subprocess that only imports server.js exits by itself (no module-level timers hold the loop)", () => {
    // Witnessed-red: pre-#476 (main 541a80aa) this child is killed by the
    // timeout with a non-zero exit — two module-level setIntervals
    // (rate-limit sweep + DB-writing task patrol) held the event loop
    // after a bare import. Post-#476 both live inside startHub, so the
    // child exits 0 on its own. Runs in a subprocess because the parent
    // test process has its own handles and can't observe loop-emptiness.
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", 'await import("./src/server.js");'],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, COMMHUB_DB: process.env.COMMHUB_DB || "/tmp/anet-476-probe.db" },
      timeout: 10_000,
    });
    expect(child.exitCode).toBe(0);
  }, 15_000);

  test("the moved task patrol actually FIRES under startHub (not just registered-looking)", () => {
    // Fake-gate guard for the #476 move: stub patrolExpiredTasks to a
    // no-op (or forget to register it in startHub) and this goes red.
    // Runs in a subprocess because startHub is single-shot per process
    // and the patrol period is shrunk via env for observability.
    const script = `
      process.env.COMMHUB_TASK_PATROL_MS = "100";
      const { startHub } = await import("./src/server.js");
      const { db } = await import("./src/db.js");
      const hub = startHub({ port: 0, hostname: "127.0.0.1" });
      db.run("DELETE FROM tasks WHERE task_id = 't476_patrol'");
      db.run("INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, created_at, expires_at) " +
             "VALUES ('t476_patrol', 'a', 'b', 'normal', 'delivered', 'x', datetime('now'), datetime('now', '-1 minute'))");
      await new Promise((r) => setTimeout(r, 600));
      const row = db.get("SELECT status FROM tasks WHERE task_id = 't476_patrol'");
      console.log("PATROL_RESULT:" + (row ? row.status : "missing"));
      db.run("DELETE FROM tasks WHERE task_id = 't476_patrol'");
      hub.stop(true);
      process.exit(0);
    `;
    const child = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, COMMHUB_DB: process.env.COMMHUB_DB || "/tmp/anet-476-patrol.db" },
      timeout: 15_000,
    });
    const out = new TextDecoder().decode(child.stdout);
    expect(out).toContain("PATROL_RESULT:expired");
  }, 20_000);
});

describe("#438 corrective — startHub is explicit, single-shot, observable", () => {
  test("startHub boots a live hub; second call throws with first boot's coordinates; bootServer stays available", async () => {
    const { startHub, bootServer, getStartedHub } = await import("./server.js") as any;
    expect(getStartedHub()).toBeNull();

    const hub = startHub({ port: 0, hostname: "127.0.0.1" });
    try {
      expect(hub.port).toBeGreaterThan(0);
      expect(getStartedHub()?.server).toBe(hub);

      // Really listening — the production liveness probe, not just a
      // non-null handle.
      const health = await fetch(`http://127.0.0.1:${hub.port}/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as any).ok).toBe(true);

      // Second call must be an OBSERVABLE rejection, not a silent no-op,
      // and must tell the caller where the first boot lives.
      let thrown: Error | null = null;
      try {
        startHub({ port: 0 });
      } catch (e: any) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(String(thrown!.message)).toContain("single-shot");
      expect(String(thrown!.message)).toContain(String(hub.port));

      // Throwaway instances stay available after startHub.
      const extra = bootServer({ port: 0, hostname: "127.0.0.1" });
      expect(extra.port).toBeGreaterThan(0);
      expect(extra.port).not.toBe(hub.port);
      extra.stop(true);
    } finally {
      hub.stop(true);
    }
  });
});
