import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  OPENCODE_DEFAULT_ADMISSION_CAP_MS,
  OPENCODE_DEFAULT_TASK_TIMEOUT_MS,
  admissionBudgetFor,
  describeOpencodeTimeout,
  resolveAdmissionCapMs,
  resolveOpencodeTimeout,
} from "./opencode-timeout";

describe("resolveOpencodeTimeout", () => {
  test("default is 30 minutes when nothing is configured", () => {
    const r = resolveOpencodeTimeout({});
    expect(OPENCODE_DEFAULT_TASK_TIMEOUT_MS).toBe(1_800_000);
    expect(r.valueMs).toBe(1_800_000);
    expect(r.sourceLabel).toBe("default");
    expect(describeOpencodeTimeout(r)).toBe("1800000ms (30min) source=default");
  });

  test("env OPENCODE_TIMEOUT_MS beats every flag", () => {
    const r = resolveOpencodeTimeout({ env: "90000", flags: { timeout: 60_000, opencodeTimeoutMs: 70_000 } });
    expect(r.valueMs).toBe(90_000);
    expect(r.sourceLabel).toBe("env OPENCODE_TIMEOUT_MS");
  });

  test("RFC-024 canonical flags.timeout beats flags.opencodeTimeoutMs", () => {
    const r = resolveOpencodeTimeout({ flags: { timeout: 60_000, opencodeTimeoutMs: 70_000 } });
    expect(r.valueMs).toBe(60_000);
    expect(r.sourceLabel).toBe("flags.timeout");
  });

  test("flags.opencodeTimeoutMs applies when flags.timeout is absent (numeric string accepted)", () => {
    expect(resolveOpencodeTimeout({ flags: { opencodeTimeoutMs: 70_000 } })).toMatchObject({
      valueMs: 70_000, sourceLabel: "flags.opencodeTimeoutMs",
    });
    expect(resolveOpencodeTimeout({ flags: { opencodeTimeoutMs: "45000" } }).valueMs).toBe(45_000);
  });

  test("0 disables the deadline from any source", () => {
    expect(resolveOpencodeTimeout({ env: "0" })).toMatchObject({ valueMs: 0, sourceLabel: "env OPENCODE_TIMEOUT_MS" });
    expect(resolveOpencodeTimeout({ flags: { timeout: 0, opencodeTimeoutMs: 70_000 } })).toMatchObject({ valueMs: 0, sourceLabel: "flags.timeout" });
    expect(resolveOpencodeTimeout({ flags: { opencodeTimeoutMs: 0 } }).valueMs).toBe(0);
    expect(describeOpencodeTimeout(resolveOpencodeTimeout({ env: "0" }))).toBe("disabled (0) source=env OPENCODE_TIMEOUT_MS");
  });

  test("invalid or negative values fall through to the next source", () => {
    expect(resolveOpencodeTimeout({ env: "abc", flags: { opencodeTimeoutMs: 70_000 } }).valueMs).toBe(70_000);
    expect(resolveOpencodeTimeout({ env: "", flags: { timeout: -1, opencodeTimeoutMs: 70_000 } })).toMatchObject({
      valueMs: 70_000, sourceLabel: "flags.opencodeTimeoutMs",
    });
    expect(resolveOpencodeTimeout({ env: "-5" }).sourceLabel).toBe("default");
  });
});

describe("admission cap (#3103)", () => {
  test("defaults to 10 minutes, not the whole task budget", () => {
    expect(OPENCODE_DEFAULT_ADMISSION_CAP_MS).toBe(600_000);
    expect(resolveAdmissionCapMs({})).toBe(600_000);
  });

  test("env overrides; 0 keeps the single-budget behaviour; junk falls back", () => {
    expect(resolveAdmissionCapMs({ env: "5000" })).toBe(5_000);
    expect(resolveAdmissionCapMs({ env: "0" })).toBe(0);
    expect(resolveAdmissionCapMs({ env: "-1" })).toBe(600_000);
    expect(resolveAdmissionCapMs({ env: "abc" })).toBe(600_000);
  });

  test("admission never takes the whole task budget", () => {
    // 30 min task, 10 min cap ⇒ queueing may spend at most 10 min,
    // leaving >= 20 min for the reply of a task that actually ran.
    expect(admissionBudgetFor(1_800_000, 600_000)).toBe(600_000);
    // A short task keeps its own (shorter) budget.
    expect(admissionBudgetFor(300_000, 600_000)).toBe(300_000);
    // Unlimited task budget still honours an explicit cap.
    expect(admissionBudgetFor(0, 600_000)).toBe(600_000);
    // cap 0 = no extra cap: unchanged legacy behaviour.
    expect(admissionBudgetFor(1_800_000, 0)).toBe(1_800_000);
    // Both unlimited: queueing is unlimited too.
    expect(admissionBudgetFor(0, 0)).toBe(0);
  });
});

// The field bug was cli.ts handing `undefined` to the copresence submit, so
// the runtime's own default always won. Both opencode dispatch paths must
// pass the resolved value. (Source contract: cli.ts has top-level side
// effects and cannot be imported in a unit test.)
describe("cli.ts wires the resolved opencode deadline", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
  test("copresence submit and headless think both receive currentOpencodeTimeout()", () => {
    expect(cli).not.toContain("runtime.submit(task, undefined");
    expect(cli).toContain("await runtime.submit(task, currentOpencodeTimeout().valueMs, _from, {");
    expect(cli).toContain("idleTimeoutMs: currentOpencodeTimeout().valueMs,");
    expect(cli).toContain("env: process.env.OPENCODE_TIMEOUT_MS,");
  });
});
