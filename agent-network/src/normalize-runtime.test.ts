// Pin the runtime fallback default — `claude-agent-sdk`, not the
// legacy `claude-code-cli` which was a poor default that left non-
// subscribers with broken nodes (Max/Pro-bound).
//
// Per Vincent's "无 Max 军团" directive (2026-06-28, 通信龙 dispatch):
// the entire surface where a user-facing runtime can default — empty,
// unknown, missing profile — must fall through to `claude-agent-sdk`.
// Explicit `claude-code-cli` choice still works.

import { describe, expect, test } from "bun:test";
import { normalizeRuntime, normalizeRuntimeStrict } from "./normalize-runtime";

describe("normalizeRuntime — fallback default is claude-agent-sdk (Vincent no-Max)", () => {
  test("legacy normalization: unknown string → claude-agent-sdk", () => {
    expect(normalizeRuntime("totally-unknown-runtime")).toBe("claude-agent-sdk");
  });

  test("empty string → claude-agent-sdk", () => {
    expect(normalizeRuntime("")).toBe("claude-agent-sdk");
  });

  test("undefined (no arg) → claude-agent-sdk", () => {
    expect(normalizeRuntime()).toBe("claude-agent-sdk");
  });

  test("undefined profile arg → claude-agent-sdk", () => {
    expect(normalizeRuntime(undefined)).toBe("claude-agent-sdk");
  });

  test("profile with missing runtime field → claude-agent-sdk", () => {
    expect(normalizeRuntime({ alias: "x" } as any)).toBe("claude-agent-sdk");
  });

  test("profile with empty-string runtime field → claude-agent-sdk", () => {
    expect(normalizeRuntime({ alias: "x", runtime: "" } as any)).toBe("claude-agent-sdk");
  });
});

describe("normalizeRuntimeStrict — execution boundaries fail closed", () => {
  test("missing and empty runtime still select the documented default", () => {
    expect(normalizeRuntimeStrict()).toBe("claude-agent-sdk");
    expect(normalizeRuntimeStrict("")).toBe("claude-agent-sdk");
    expect(normalizeRuntimeStrict({})).toBe("claude-agent-sdk");
  });

  test("canonical names and supported aliases are accepted", () => {
    expect(normalizeRuntimeStrict("opencode-cli")).toBe("opencode-cli");
    expect(normalizeRuntimeStrict("opencode")).toBe("opencode-cli");
    expect(normalizeRuntimeStrict({ runtime: "codex-tui" })).toBe("codex-app-server");
  });

  test("a non-empty unknown runtime is rejected", () => {
    expect(() => normalizeRuntimeStrict("bogus-runtime-name")).toThrow("unsupported runtime");
    expect(() => normalizeRuntimeStrict({ runtime: "bogus-runtime-name" })).toThrow(
      "bogus-runtime-name",
    );
  });
});

describe("normalizeRuntime — explicit choices are preserved", () => {
  // Operators who actually want a specific runtime still get it. The
  // fallback flip ONLY affects missing/unknown cases.

  test("explicit 'claude-code-cli' → claude-code-cli (operator opt-in still works)", () => {
    expect(normalizeRuntime("claude-code-cli")).toBe("claude-code-cli");
  });

  test("explicit 'claude-agent-sdk' → claude-agent-sdk", () => {
    expect(normalizeRuntime("claude-agent-sdk")).toBe("claude-agent-sdk");
  });

  test("alias 'claude' → claude-agent-sdk (existing canonicalization)", () => {
    expect(normalizeRuntime("claude")).toBe("claude-agent-sdk");
  });

  test("alias 'claude-sdk' → claude-agent-sdk", () => {
    expect(normalizeRuntime("claude-sdk")).toBe("claude-agent-sdk");
  });

  test("alias 'agent-sdk' (string form) → claude-agent-sdk", () => {
    expect(normalizeRuntime("agent-sdk")).toBe("claude-agent-sdk");
  });

  test("'codex' / 'codex-sdk' → codex-sdk", () => {
    expect(normalizeRuntime("codex")).toBe("codex-sdk");
    expect(normalizeRuntime("codex-sdk")).toBe("codex-sdk");
  });

  test("'grok' / 'grok-build' / 'grok-build-acp' → grok-build-acp", () => {
    expect(normalizeRuntime("grok")).toBe("grok-build-acp");
    expect(normalizeRuntime("grok-build")).toBe("grok-build-acp");
    expect(normalizeRuntime("grok-build-acp")).toBe("grok-build-acp");
  });

  test("explicit Grok co-presence names → grok-build-cli", () => {
    expect(normalizeRuntime("grok-build-cli")).toBe("grok-build-cli");
    expect(normalizeRuntime("grok-cli")).toBe("grok-build-cli");
    expect(normalizeRuntime("grok-tui")).toBe("grok-build-cli");
    expect(normalizeRuntime({ runtime: "grok-build-cli" } as any)).toBe("grok-build-cli");
  });

  // RFC-029 — public sst/opencode CLI runtime. Both the canonical name
  // (`opencode-cli`, matching claude-code-cli precedent) and the short
  // alias `opencode` resolve to the same bucket. Explicit choice is
  // preserved; unknown drift falls through to the safe default via the
  // existing "unknown → claude-agent-sdk" rule (see suite 1).
  test("explicit 'opencode-cli' → opencode-cli (canonical launcher name)", () => {
    expect(normalizeRuntime("opencode-cli")).toBe("opencode-cli");
  });

  test("alias 'opencode' → opencode-cli (short form)", () => {
    expect(normalizeRuntime("opencode")).toBe("opencode-cli");
  });

  test("profile with runtime='opencode-cli' → opencode-cli", () => {
    expect(normalizeRuntime({ runtime: "opencode-cli" } as any)).toBe("opencode-cli");
  });

  test("profile with runtime='opencode' → opencode-cli", () => {
    expect(normalizeRuntime({ runtime: "opencode" } as any)).toBe("opencode-cli");
  });

  // RFC-030 — codex TUI bridge (standalone `codex app-server`). Canonical
  // `codex-app-server` plus aliases `codex-tui` / `codex-appserver`. These
  // must NOT collapse into `codex-sdk` (a different runtime).
  test("explicit 'codex-app-server' → codex-app-server", () => {
    expect(normalizeRuntime("codex-app-server")).toBe("codex-app-server");
  });

  test("alias 'codex-tui' → codex-app-server", () => {
    expect(normalizeRuntime("codex-tui")).toBe("codex-app-server");
  });

  test("alias 'codex-appserver' → codex-app-server", () => {
    expect(normalizeRuntime("codex-appserver")).toBe("codex-app-server");
  });

  test("'codex-sdk' still → codex-sdk (not shadowed by the app-server branch)", () => {
    expect(normalizeRuntime("codex-sdk")).toBe("codex-sdk");
  });

  test("'codex' still → codex-sdk (legacy short alias unchanged)", () => {
    expect(normalizeRuntime("codex")).toBe("codex-sdk");
  });

  test("profile with runtime='codex-app-server' → codex-app-server", () => {
    expect(normalizeRuntime({ runtime: "codex-app-server" } as any)).toBe("codex-app-server");
  });
});

describe("normalizeRuntime — profile object paths", () => {
  test("profile with runtime='claude-code-cli' → claude-code-cli (explicit, preserved)", () => {
    expect(normalizeRuntime({ runtime: "claude-code-cli" } as any)).toBe("claude-code-cli");
  });

  test("profile with runtime='agent-sdk' + codexRuntime='codex' → codex-sdk (legacy hybrid)", () => {
    expect(normalizeRuntime({ runtime: "agent-sdk", codexRuntime: "codex" } as any)).toBe("codex-sdk");
  });

  test("profile with runtime='agent-sdk' + no codexRuntime → claude-agent-sdk", () => {
    expect(normalizeRuntime({ runtime: "agent-sdk" } as any)).toBe("claude-agent-sdk");
  });

  test("legacy profile normalization keeps unknown → default for display/migration", () => {
    expect(normalizeRuntime({ runtime: "bogus-runtime-name" } as any)).toBe("claude-agent-sdk");
  });
});
