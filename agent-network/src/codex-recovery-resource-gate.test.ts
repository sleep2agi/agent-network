import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEX_RECOVERY_MAX_PAYLOAD_BYTES } from "./codex-copresence-resume-timeout";
import {
  CODEX_RECOVERY_MEMORY_MULTIPLIER,
  CODEX_RECOVERY_MIN_MEMORY_MB,
  estimatedCodexRecoveryMemoryMb,
  waitForCodexRecoveryResources,
} from "./codex-recovery-resource-gate";

describe("Codex legacy recovery resource gate", () => {
  test("uses the measured 9x memory envelope with a 4 GiB floor", () => {
    expect(CODEX_RECOVERY_MEMORY_MULTIPLIER).toBe(9);
    expect(estimatedCodexRecoveryMemoryMb(null)).toBe(CODEX_RECOVERY_MIN_MEMORY_MB);
    expect(estimatedCodexRecoveryMemoryMb(100 * 1024 ** 2)).toBe(CODEX_RECOVERY_MIN_MEMORY_MB);
    expect(estimatedCodexRecoveryMemoryMb(500 * 1024 ** 2)).toBe(4500);
  });

  test("the largest accepted frame still gets a finite memory reservation", () => {
    expect(estimatedCodexRecoveryMemoryMb(CODEX_RECOVERY_MAX_PAYLOAD_BYTES / 2)).toBe(6912);
  });

  test("uses a distinct single recovery lane and a rollout-sized memory floor", async () => {
    let captured: { label: string; deps: Record<string, any> } | undefined;
    const release = () => {};
    const result = await waitForCodexRecoveryResources("node_test", 500 * 1024 ** 2, {
      env: { ANET_START_MIN_MEM_MB: "4300" },
      slotsDir: "/tmp/recovery-slots-test",
      gate: async (label, deps) => {
        captured = { label, deps: deps as Record<string, any> };
        return { outcome: "ok", waitedMs: 0, checks: 1, release };
      },
    });
    expect(result.release).toBe(release);
    expect(captured?.label).toBe("codex legacy recovery");
    expect(captured?.deps.nodeId).toBe("node_test");
    expect(captured?.deps.slotsDir).toBe("/tmp/recovery-slots-test");
    expect(captured?.deps.env.ANET_START_MIN_MEM_MB).toBe("4500");
    expect(captured?.deps.env.ANET_START_MAX_CONCURRENT).toBe("1");
  });

  test("warns when the recovery quota is unavailable off Linux", async () => {
    const warnings: string[] = [];
    const result = await waitForCodexRecoveryResources("node_test", 1, {
      platform: "darwin",
      warn: (message) => warnings.push(message),
    });
    expect(result.outcome).toBe("unsupported");
    expect(warnings.join("\n")).toContain("Linux-only protection");
  });

  test.skipIf(process.platform !== "linux")("a live holder renews past TTL; SIGKILL permits takeover within one TTL", async () => {
    const root = mkdtempSync(join(tmpdir(), "anet-recovery-heartbeat-"));
    const slots = join(root, "slots");
    const script = join(root, "holder.mjs");
    const gateHref = pathToFileURL(join(import.meta.dir, "start-resource-gate.ts")).href;
    writeFileSync(script, `
      import { waitForStartResources } from ${JSON.stringify(gateHref)};
      const slotsDir = process.argv[2];
      const name = process.argv[3];
      const mem = "MemTotal: 16777216 kB\\nMemAvailable: 8388608 kB\\n";
      const gate = await waitForStartResources(name, {
        env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "4", ANET_START_MIN_MEM_MB: "1", ANET_START_MAX_LOAD_PER_CPU: "999" },
        platform: "linux",
        slotsDir,
        nodeId: name,
        leaseTtlMs: 600,
        leaseHeartbeatMs: 100,
        recheckMs: 20,
        jitterMs: 0,
        readFile: (path) => path === "/proc/meminfo" ? mem : path === "/proc/loadavg" ? "0.01 0 0 1/1 1\\n" : null,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: () => {},
        warn: (message) => console.error(message),
      });
      console.log("ACQUIRED " + name + " " + Date.now());
      setInterval(() => {}, 1000);
    `, { mode: 0o600 });
    const launch = (name: string) => {
      const child = spawn(process.execPath, [script, slots, name], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += String(data); });
      child.stderr.on("data", (data) => { stderr += String(data); });
      return { child, stdout: () => stdout, stderr: () => stderr };
    };
    const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      return predicate();
    };
    const first = launch("first");
    let second: ReturnType<typeof launch> | undefined;
    try {
      expect(await waitFor(() => first.stdout().includes("ACQUIRED first"), 3_000), first.stderr()).toBe(true);
      second = launch("second");
      // Longer than the 600ms lease: a missing heartbeat would admit second.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(second.stdout(), second.stderr()).not.toContain("ACQUIRED second");
      const killedAt = Date.now();
      first.child.kill("SIGKILL");
      expect(await waitFor(() => second!.stdout().includes("ACQUIRED second"), 600), second.stderr()).toBe(true);
      expect(Date.now() - killedAt).toBeLessThanOrEqual(600);
    } finally {
      first.child.kill("SIGKILL");
      second?.child.kill("SIGKILL");
      const exited = (child: typeof first.child) => child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await Promise.all([exited(first.child), ...(second ? [exited(second.child)] : [])]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("both native launchers hold the recovery lease through TUI attribution", () => {
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    expect(cli.match(/await holdCodexRecovery\(/g)).toHaveLength(2);
    expect(cli.match(/recoveryAdmission(?:\?\.|\.)release\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    const posixAcquire = cli.indexOf("recoveryAdmission = await holdCodexRecovery(nodeId");
    const posixHealth = cli.indexOf("client-health role=tui", posixAcquire);
    const posixRelease = cli.indexOf("recoveryAdmission?.release()", posixHealth);
    expect(posixAcquire).toBeGreaterThan(0);
    expect(posixHealth).toBeGreaterThan(posixAcquire);
    expect(posixRelease).toBeGreaterThan(posixHealth);
  });
});
