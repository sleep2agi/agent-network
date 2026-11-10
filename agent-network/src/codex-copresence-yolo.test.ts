import { describe, expect, test } from "bun:test";
import {
  CODEX_COPRESENCE_YOLO_FLAGS,
  applyCodexCopresenceFlagDefaults,
  mergeCopresenceYoloIntoToml,
} from "./codex-copresence-yolo";

describe("co-presence yolo defaults", () => {
  test("fills only missing flag keys", () => {
    const flags: Record<string, unknown> = { approvalPolicy: "on-request" };
    applyCodexCopresenceFlagDefaults(flags);
    expect(flags).toEqual({
      approvalPolicy: "on-request",
      sandboxMode: "danger-full-access",
      skipGitRepoCheck: true,
    });
  });

  test("mergeCopresenceYoloIntoToml sets approval_policy and sandbox_mode", () => {
    const out = mergeCopresenceYoloIntoToml('model = "gpt-x"\n');
    expect(out).toContain('approval_policy = "never"');
    expect(out).toContain('sandbox_mode = "danger-full-access"');
    expect(out).toContain('model = "gpt-x"');
  });

  test("exported API flags match client #815", () => {
    expect(CODEX_COPRESENCE_YOLO_FLAGS).toEqual({
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      skipGitRepoCheck: true,
    });
  });
});
