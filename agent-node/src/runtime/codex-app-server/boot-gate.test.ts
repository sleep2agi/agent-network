// RFC-030 Wave 1B L2 — production-entry boot-gate integration tests
// (副指挥 P0: "危险 config 无法到 spawn" must be proven on the REAL
// openCodexAppServerRuntime path, not a pure helper).
//
// Instrumentation: `binary` points at a marker script that appends every
// invocation's argv to a log file. If a gate works, the log stays empty
// (profile gate) or shows only gate probes and never an `app-server`
// spawn (baseline gate).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openCodexAppServerRuntime } from "./runtime";

const dir = mkdtempSync(join(tmpdir(), "rfc030-bootgate-"));
const invocationLog = join(dir, "invocations.log");
const fakeCodex = join(dir, "fake-codex.sh");

// Marker binary: logs argv, then answers --version with a WRONG version
// (so the real baseline gate fails closed against it) and exits.
writeFileSync(
  fakeCodex,
  `#!/bin/sh
echo "$@" >> "${invocationLog}"
if [ "$1" = "--version" ]; then echo "codex-cli 999.999.999"; exit 0; fi
exit 0
`,
);
chmodSync(fakeCodex, 0o755);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function invocations(): string[] {
  return existsSync(invocationLog)
    ? readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

describe("openCodexAppServerRuntime — Phase-1 fail-closed gates (production entry)", () => {
  test("dangerous sandbox_mode NEVER reaches spawn: throws before ANY binary invocation", async () => {
    for (const sandboxMode of ["workspace-write", "danger-full-access"]) {
      const before = invocations().length;
      await expect(
        openCodexAppServerRuntime({ binary: fakeCodex, sandboxMode }),
      ).rejects.toThrow(/Phase 1 requires sandbox_mode=read-only/);
      expect(invocations().length).toBe(before); // ZERO invocations — not even --version
    }
  });

  test("dangerous approval_policy NEVER reaches spawn", async () => {
    for (const approvalPolicy of ["on-request", "on-failure", "untrusted"]) {
      const before = invocations().length;
      await expect(
        openCodexAppServerRuntime({ binary: fakeCodex, approvalPolicy }),
      ).rejects.toThrow(/Phase 1 requires approval_policy=never/);
      expect(invocations().length).toBe(before);
    }
  });

  test("baseline gate runs on the SAME binary BEFORE spawn: wrong version → refuse, no app-server invocation", async () => {
    const before = invocations().length;
    await expect(
      openCodexAppServerRuntime({
        binary: fakeCodex,
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ).rejects.toThrow(/codex baseline mismatch/);
    const after = invocations();
    expect(after.length).toBeGreaterThan(before); // the gate DID probe --version
    // …but no `app-server` spawn ever happened:
    expect(after.some((line) => line.startsWith("app-server"))).toBe(false);
  });

  test("shared/adopt topology refused fail-closed BEFORE any socket (Phase 1: unverifiable remote profile)", async () => {
    // Live local listener counting connection attempts — must stay 0.
    let connections = 0;
    const srv = Bun.serve({
      port: 0,
      fetch(req, s) {
        connections++;
        if (s.upgrade(req)) return undefined;
        return new Response("", { status: 400 });
      },
      websocket: { message() {} },
    });
    try {
      await expect(
        openCodexAppServerRuntime({ serverUrl: `ws://127.0.0.1:${srv.port}` }),
      ).rejects.toThrow(/shared app-server is refused/);
      // Typed code, and the listener never saw a connection.
      try {
        await openCodexAppServerRuntime({ serverUrl: `ws://127.0.0.1:${srv.port}` });
      } catch (e) {
        expect((e as Error & { code?: string }).code).toBe(
          "codex_gateway_phase1_shared_unverified",
        );
      }
      expect(connections).toBe(0);
    } finally {
      srv.stop(true);
    }
  });

  test("injected baseline gate is honored (DI seam for tests; default is the real assertCodexBaseline)", async () => {
    // Prove the gate ordering: profile → baseline → spawn. An injected
    // gate that throws must stop the boot with ZERO binary invocations.
    const before = invocations().length;
    await expect(
      openCodexAppServerRuntime({
        binary: fakeCodex,
        baselineGate: async () => {
          throw new Error("injected-gate-refusal");
        },
      }),
    ).rejects.toThrow("injected-gate-refusal");
    expect(invocations().length).toBe(before);
  });
});
