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
