import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
