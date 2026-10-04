// #534 — codex-sdk retry/rebuild and goal-wake paths must honour the node's
// configured sandbox / approval flags, not a hard-coded full-access posture.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCodexSdkThreadOptions,
  buildCodexStdioThreadStartParams,
  rebuildCodexSdkThread,
  type CodexSdkThreadOptions,
} from "./codex-sdk-thread-options";
import { runCodexWakeForGoal, type CodexThreadFake } from "./goals/codex-wake";
import type { AgentGoal } from "./goals/types";

const RESTRICTED_FLAGS = {
  sandboxMode: "read-only",
  approvalPolicy: "on-request",
  skipGitRepoCheck: false,
};

function recordingCodex() {
  const calls: Array<{ kind: "startThread" | "resumeThread"; opts: unknown }> = [];
  const thread = (id: string): CodexThreadFake => ({
    id,
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: "item.completed", item: { type: "agent_message", text: "ok" } };
      })(),
    }),
  });
  return {
    calls,
    client: {
      startThread(opts: unknown) {
        calls.push({ kind: "startThread", opts });
        return thread("fresh-thread");
      },
      resumeThread(_id: string, opts: unknown) {
        calls.push({ kind: "resumeThread", opts });
        throw new Error("thread not found");
      },
    },
  };
}

describe("#534 buildCodexSdkThreadOptions", () => {
  test("unconfigured node keeps the pre-#534 defaults exactly", () => {
    const expected: CodexSdkThreadOptions = {
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      model: "m",
      sandboxMode: "danger-full-access",
      modelReasoningEffort: "low",
    };
    expect(buildCodexSdkThreadOptions(undefined, "m")).toEqual(expected);
    expect(buildCodexSdkThreadOptions({}, "m")).toEqual(expected);
    expect(buildCodexSdkThreadOptions(null, "m")).toEqual(expected);
    // non-string values were ignored by the primary path before; still are.
    expect(buildCodexSdkThreadOptions({ sandboxMode: 1, approvalPolicy: true }, "m")).toEqual(expected);
  });

  test("configured flags win", () => {
    expect(buildCodexSdkThreadOptions(RESTRICTED_FLAGS, "o3")).toEqual({
      skipGitRepoCheck: false,
      approvalPolicy: "on-request",
      model: "o3",
      sandboxMode: "read-only",
      modelReasoningEffort: "low",
    });
  });
});

describe("#534 retry/rebuild path", () => {
  test("rebuild after a failed turn passes the configured read-only / on-request options", () => {
    const fake = recordingCodex();
    rebuildCodexSdkThread(fake.client, RESTRICTED_FLAGS, "o3");
    expect(fake.calls).toHaveLength(1);
    const opts = fake.calls[0].opts as CodexSdkThreadOptions;
    expect(opts.sandboxMode).toBe("read-only");
    expect(opts.approvalPolicy).toBe("on-request");
    expect(opts.skipGitRepoCheck).toBe(false);
    expect(opts.model).toBe("o3");
  });

  test("workspace-write node is not escalated on rebuild", () => {
    const fake = recordingCodex();
    rebuildCodexSdkThread(fake.client, { sandboxMode: "workspace-write" }, "m");
    expect((fake.calls[0].opts as CodexSdkThreadOptions).sandboxMode).toBe("workspace-write");
  });
});

describe("#534 goal wake path", () => {
  test("resume failure → rebuilt thread both carry the configured options", async () => {
    const fake = recordingCodex();
    const now = new Date().toISOString();
    const goal: AgentGoal = {
      goal_id: "goal-534-abcdef",
      text: "t",
      status: "active",
      interval_ms: 60_000,
      next_wake_at: now,
      runtime: "codex-sdk",
      created_at: now,
      updated_at: now,
      progress_log: [],
      codex_thread_id: "old-thread",
    };
    const result = await runCodexWakeForGoal(goal, "wake", {
      newCodex: () => fake.client,
      buildOpts: () => buildCodexSdkThreadOptions(RESTRICTED_FLAGS, "o3"),
    });
    expect(result.threadRebuilt).toBe(true);
    expect(fake.calls.map((c) => c.kind)).toEqual(["resumeThread", "startThread"]);
    for (const c of fake.calls) {
      const opts = c.opts as CodexSdkThreadOptions;
      expect(opts.sandboxMode).toBe("read-only");
      expect(opts.approvalPolicy).toBe("on-request");
    }
  });
});

describe("#534 cli.ts has no second option literal", () => {
  const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("every codex-sdk startThread/resumeThread call goes through the shared builder", () => {
    const calls = [...cli.matchAll(/codex\.(startThread|resumeThread)\(([^)]*)\)/g)].map((m) => m[0]);
    // start + resume on the primary path; the retry uses rebuildCodexSdkThread.
    expect(calls).toEqual([
      "codex.resumeThread(SESSION_ID, codexOpts)",
      "codex.startThread(codexOpts)",
    ]);
    expect(cli).toContain("const codexOpts = buildCodexSdkThreadOptions(fileConfig?.flags, codexModel);");
    expect(cli).toContain("codexThread = rebuildCodexSdkThread(codex, fileConfig?.flags, resolveCodexModel(MODEL));");
    expect(cli).toContain("buildOpts: () => buildCodexSdkThreadOptions(fileConfig?.flags, resolveCodexModel(MODEL)),");
  });

  test("no hard-coded codex-sdk permission literal remains", () => {
    expect(cli).not.toMatch(/sandboxMode:\s*"danger-full-access"/);
    expect(cli).not.toMatch(/approvalPolicy:\s*"never"/);
  });
});

describe("#538 ANET_CODEX_STDIO_DIRECT=1 thread/start params", () => {
  test("configured read-only / never reaches the wire as `sandbox` + `approvalPolicy`", () => {
    expect(buildCodexStdioThreadStartParams({ sandboxMode: "read-only", approvalPolicy: "never" }, "o3")).toEqual({
      model: "o3",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });

  test("workspace-write is passed through, not escalated", () => {
    const p = buildCodexStdioThreadStartParams({ sandboxMode: "workspace-write" }, "m");
    expect(p.sandbox).toBe("workspace-write");
    expect(p.approvalPolicy).toBe("on-request");
  });

  test("unconfigured node keeps the pre-#538 wire posture and is NOT escalated to full access", () => {
    for (const flags of [undefined, null, {}, { sandboxMode: 1, approvalPolicy: true }]) {
      const p = buildCodexStdioThreadStartParams(flags, "m");
      expect(p).toEqual({ model: "m", approvalPolicy: "on-request" });
      expect("sandbox" in p).toBe(false);
    }
  });

  test("no `sandboxPolicy` key (app-server thread/start ignores it) and no full-access value ever", () => {
    const shapes = [undefined, {}, { sandboxMode: "read-only" }, { approvalPolicy: "never" }];
    for (const flags of shapes) {
      const p = buildCodexStdioThreadStartParams(flags, "m") as unknown as Record<string, unknown>;
      expect("sandboxPolicy" in p).toBe(false);
      expect(JSON.stringify(p)).not.toMatch(/dangerFullAccess|danger-full-access/);
    }
  });

  test("threadId is carried only when a session id is set", () => {
    expect(buildCodexStdioThreadStartParams({}, "m", "sess-1").threadId).toBe("sess-1");
    expect("threadId" in buildCodexStdioThreadStartParams({}, "m", "")).toBe(false);
    expect("threadId" in buildCodexStdioThreadStartParams({}, "m", null)).toBe(false);
  });
});

describe("#538 cli.ts stdio lane goes through the builder", () => {
  const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("processWithCodexStdio builds thread/start from fileConfig.flags", () => {
    const start = cli.indexOf("async function processWithCodexStdio(");
    const end = cli.indexOf('client.request<{ thread: { id: string } }>("thread/start", opts)', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = cli.slice(start, end);
    expect(body).toContain(
      "const opts = buildCodexStdioThreadStartParams(fileConfig?.flags, resolveCodexModel(MODEL), SESSION_ID);",
    );
    expect(body).not.toMatch(/sandboxPolicy\s*:/);
    expect(body).not.toMatch(/approvalPolicy:\s*"on-request"/);
  });

  test("no hard-coded app-server full-access literal remains in cli.ts", () => {
    expect(cli).not.toMatch(/sandboxPolicy:\s*\{\s*type:\s*"dangerFullAccess"/);
  });
});
