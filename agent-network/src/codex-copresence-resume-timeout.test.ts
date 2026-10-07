import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CODEX_RESUME_BASE_TIMEOUT_MS,
  CODEX_RESUME_MAX_TIMEOUT_MS,
  codexThreadIdForStart,
  resolveCopresenceBridgeAttachTimeoutMs,
  resolveCopresenceMaxPayloadBytes,
  resolveCopresenceResumeBudget,
  resolveCopresenceResumeTimeoutMs,
} from "./codex-copresence-resume-timeout";

const THREAD = "01999999-1111-7222-8333-444444444444";

function rollout(bytes: number): string {
  const home = mkdtempSync(join(tmpdir(), "anet-resume-timeout-"));
  const dir = join(home, "sessions", "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-x-${THREAD}.jsonl`);
  writeFileSync(file, "");
  truncateSync(file, bytes);
  return home;
}

describe("Codex co-presence resume timeout", () => {
  test("--new-session suppresses the recorded co-presence thread", () => {
    expect(codexThreadIdForStart(THREAD, true)).toBeUndefined();
    expect(codexThreadIdForStart(THREAD, false)).toBe(THREAD);
    expect(codexThreadIdForStart(undefined, false)).toBeUndefined();
  });

  test("default grows by 120 seconds per started GiB and caps at 15 minutes", () => {
    expect(resolveCopresenceResumeTimeoutMs(rollout(1), THREAD, {})).toBe(420_000);
    expect(resolveCopresenceResumeTimeoutMs(rollout(1024 ** 3 + 1), THREAD, {})).toBe(540_000);
    expect(resolveCopresenceResumeTimeoutMs(rollout(8 * 1024 ** 3), THREAD, {})).toBe(CODEX_RESUME_MAX_TIMEOUT_MS);
  });

  test("missing or ambiguous rollout keeps the 300 second base", () => {
    expect(resolveCopresenceResumeTimeoutMs(rollout(1), undefined, {})).toBe(CODEX_RESUME_BASE_TIMEOUT_MS);
    expect(resolveCopresenceResumeTimeoutMs("/does/not/exist", THREAD, {})).toBe(CODEX_RESUME_BASE_TIMEOUT_MS);
  });

  test("valid environment override wins; invalid values warn and fall back", () => {
    const warnings: string[] = [];
    expect(resolveCopresenceResumeTimeoutMs("/none", THREAD, { ANET_CODEX_RESUME_TIMEOUT_MS: "420000" }, warnings.push.bind(warnings))).toBe(420_000);
    expect(resolveCopresenceResumeTimeoutMs("/none", THREAD, { ANET_CODEX_RESUME_TIMEOUT_MS: "900001" }, warnings.push.bind(warnings))).toBe(300_000);
    expect(warnings).toHaveLength(1);
  });

  test("budget retains rollout bytes for timeout diagnostics even with an override", () => {
    const bytes = 780 * 1024 ** 2;
    expect(resolveCopresenceResumeBudget(rollout(bytes), THREAD, { ANET_CODEX_RESUME_TIMEOUT_MS: "350000" }))
      .toEqual({ timeoutMs: 350_000, rolloutBytes: bytes });
  });

  test("large-frame ceiling is finite, size-aware, and bridge readiness covers both attempts", () => {
    expect(resolveCopresenceMaxPayloadBytes(null)).toBe(128 * 1024 ** 2);
    expect(resolveCopresenceMaxPayloadBytes(502 * 1024 ** 2)).toBe(1068 * 1024 ** 2);
    expect(resolveCopresenceMaxPayloadBytes(2 * 1024 ** 3)).toBe(1536 * 1024 ** 2);
    expect(resolveCopresenceBridgeAttachTimeoutMs(420_000)).toBe(850_000);
  });
});

describe("--new-session co-presence wiring", () => {
  const cli = readFileSync(join(import.meta.dir, "../bin/cli.ts"), "utf8");

  test("Windows and POSIX both suppress the recorded and pending thread", () => {
    expect(cli.match(/const requestedThreadId = codexThreadIdForStart\(/g)).toHaveLength(2);
    expect(cli.match(/if \(opts\.newSession\) delete rawCfg\.codexPendingThread;/g)).toHaveLength(2);
    expect(cli).toContain("newSession: forceNewSession,");
  });

  test("both launchers give bridge and TUI the finite payload/recovery budget", () => {
    expect(cli.match(/ANET_CODEX_RECOVERY_MAX_PAYLOAD_BYTES:/g)).toHaveLength(2);
    expect(cli.match(/resolveCopresenceBridgeAttachTimeoutMs\(/g)).toHaveLength(4); // bridge + TUI on Windows + POSIX
    expect(cli).not.toContain("waitForFileText(bridgeLog, bridgeReceipt, 25_000)");
    expect(cli).toContain("const TUI_HEALTH_MS = resolveCopresenceBridgeAttachTimeoutMs(resumeBudget.timeoutMs);");
    expect(cli).toContain("const TUI_PAINT_TIMEOUT_MS = resolveCopresenceBridgeAttachTimeoutMs(recoveryTimeoutMs);");
    expect(cli).not.toContain("const TUI_PAINT_TIMEOUT_MS = 40_000;");
  });
});
