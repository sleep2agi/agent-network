import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CODEX_RESUME_BASE_TIMEOUT_MS,
  CODEX_RESUME_MAX_TIMEOUT_MS,
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
});
