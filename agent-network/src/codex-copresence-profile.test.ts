import { describe, expect, test } from "bun:test";
import {
  CODEX_COPRESENCE_RUNTIME,
  codexCopresencePosture,
  codexCopresenceRequested,
  shouldPersistCodexCopresence,
  shouldPersistCodexFullAccess,
} from "./codex-copresence-profile";

const YOLO = { approvalPolicy: "never", sandboxMode: "danger-full-access", skipGitRepoCheck: true };

describe("one command instead of a flag every time", () => {
  test("a profile that remembers co-presence needs no flag", () => {
    expect(codexCopresenceRequested(false, { runtime: CODEX_COPRESENCE_RUNTIME, codexCopresence: true })).toBe(true);
  });

  test("the flag still works for a profile that has not recorded it", () => {
    expect(codexCopresenceRequested(true, { runtime: CODEX_COPRESENCE_RUNTIME })).toBe(true);
  });

  test("without either, start stays on the normal lane", () => {
    expect(codexCopresenceRequested(false, { runtime: CODEX_COPRESENCE_RUNTIME })).toBe(false);
  });

  test("the profile field cannot drag a non-codex runtime into the codex dance", () => {
    // Otherwise a stray field on e.g. a claude node would route it into an
    // orchestration whose very first guard rejects it, turning a typo into a
    // hard exit on an unrelated node.
    expect(codexCopresenceRequested(false, { runtime: "codex-sdk", codexCopresence: true })).toBe(false);
    expect(codexCopresenceRequested(false, { runtime: "claude-code-cli", codexCopresence: true })).toBe(false);
  });

  test("remembers only when the flag taught it something new", () => {
    expect(shouldPersistCodexCopresence(true, { runtime: CODEX_COPRESENCE_RUNTIME })).toBe(true);
    expect(shouldPersistCodexCopresence(true, { runtime: CODEX_COPRESENCE_RUNTIME, codexCopresence: true })).toBe(false);
    expect(shouldPersistCodexCopresence(false, { runtime: CODEX_COPRESENCE_RUNTIME })).toBe(false);
    expect(shouldPersistCodexCopresence(true, { runtime: "codex-sdk" })).toBe(false);
  });
});

describe("sandbox posture", () => {
  test("read-only remains the default — the flag is still what opens it", () => {
    const p = codexCopresencePosture(false, { runtime: CODEX_COPRESENCE_RUNTIME });
    expect(p.sandboxMode).toBe("read-only");
    expect(p.approvalPolicy).toBe("on-request");
  });

  test("flags.sandboxMode alone does NOT open the sandbox", () => {
    // The whole point of the Risk C safeguard. If this ever flips, a node
    // created with default yolo flags would silently gain write access the
    // moment someone attaches a TUI to it.
    const p = codexCopresencePosture(false, { runtime: CODEX_COPRESENCE_RUNTIME, flags: YOLO });
    expect(p.sandboxMode).toBe("read-only");
    expect(p.grantedFromProfile).toBe(false);
  });

  test("but the mismatch is announced, naming both values and the fix", () => {
    // The defect being fixed is silence, not the default itself: the node ran
    // full-access on one lane and read-only on the other with nothing printed.
    const p = codexCopresencePosture(false, { runtime: CODEX_COPRESENCE_RUNTIME, flags: YOLO }, "通信牛");
    expect(p.downgradeNotice).toBeDefined();
    expect(p.downgradeNotice).toContain("danger-full-access");
    expect(p.downgradeNotice).toContain("read-only");
    expect(p.downgradeNotice).toContain("通信牛");
    expect(p.downgradeNotice).toContain("--dangerously-allow-full-access");
  });

  test("no notice when the node never asked for full access", () => {
    expect(codexCopresencePosture(false, { runtime: CODEX_COPRESENCE_RUNTIME, flags: {} }).downgradeNotice).toBeUndefined();
    expect(codexCopresencePosture(false, { runtime: CODEX_COPRESENCE_RUNTIME }).downgradeNotice).toBeUndefined();
  });

  test("the explicit flag opens it, and says the grant came from this invocation", () => {
    const p = codexCopresencePosture(true, { runtime: CODEX_COPRESENCE_RUNTIME, flags: YOLO });
    expect(p.sandboxMode).toBe("danger-full-access");
    expect(p.approvalPolicy).toBe("never");
    expect(p.grantedFromProfile).toBe(false);
    expect(p.downgradeNotice).toBeUndefined();
  });

  test("a remembered grant opens it without retyping, and is labelled as remembered", () => {
    const p = codexCopresencePosture(false, { runtime: CODEX_COPRESENCE_RUNTIME, codexCopresenceFullAccess: true });
    expect(p.sandboxMode).toBe("danger-full-access");
    expect(p.grantedFromProfile).toBe(true);
  });

  test("approvalPolicy and sandboxMode never disagree", () => {
    // They are two halves of one posture; a pair like read-only + never would
    // let a turn be auto-approved and then fail on every write.
    for (const profile of [
      {}, { flags: YOLO }, { codexCopresenceFullAccess: true }, { flags: YOLO, codexCopresenceFullAccess: true },
    ]) {
      for (const flag of [true, false]) {
        const p = codexCopresencePosture(flag, { runtime: CODEX_COPRESENCE_RUNTIME, ...profile });
        expect(p.approvalPolicy).toBe(p.sandboxMode === "danger-full-access" ? "never" : "on-request");
      }
    }
  });

  test("remembers an explicit grant only once", () => {
    expect(shouldPersistCodexFullAccess(true, {})).toBe(true);
    expect(shouldPersistCodexFullAccess(true, { codexCopresenceFullAccess: true })).toBe(false);
    expect(shouldPersistCodexFullAccess(false, {})).toBe(false);
  });
});
