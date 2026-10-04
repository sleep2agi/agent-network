// #534 — codex-sdk retry/rebuild and goal-wake paths must honour the node's
// configured sandbox / approval flags, not a hard-coded full-access posture.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCodexSdkThreadOptions,
  buildCodexStdioThreadResumeParams,
  buildCodexStdioThreadStartParams,
  codexStdioResumeRefusal,
  CodexStdioResumeError,
  isCodexThreadGoneError,
  openCodexStdioThread,
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

  test("#553 thread/start never carries a threadId (codex ignores it and opens a new thread)", () => {
    const p = buildCodexStdioThreadStartParams({}, "m") as unknown as Record<string, unknown>;
    expect("threadId" in p).toBe(false);
  });
});

describe("#538/#553 cli.ts stdio lane goes through the shared opener", () => {
  const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  const start = cli.indexOf("async function processWithCodexStdio(");
  const end = cli.indexOf("\n}\n", start);
  const body = cli.slice(start, end);

  test("processWithCodexStdio opens the thread with the recorded id + fileConfig.flags", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("const opened = await openCodexStdioThread(client, {");
    expect(body).toContain("recordedThreadId: codexStdioRecordedThreadId,");
    expect(body).toContain("flags: fileConfig?.flags,");
    expect(body).toContain("model: resolveCodexModel(MODEL),");
    expect(body).not.toMatch(/sandboxPolicy\s*:/);
    expect(body).not.toMatch(/approvalPolicy:\s*"on-request"/);
    // no direct thread/start that could bypass the resume
    expect(body).not.toMatch(/request(<[^>]*>+)?\(\s*"thread\/(start|resume)"/);
  });

  test("the thread id is recorded after the turn, not at thread/start", () => {
    const open = body.indexOf("openCodexStdioThread(");
    const turn = body.indexOf('"turn/start"');
    const write = body.indexOf("writebackSession(codexStdioThreadId)");
    expect(open).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(turn);
    expect(body.indexOf("writebackSession(")).toBe(write);
  });

  test("the recorded id starts from the boot session and survives an app-server exit", () => {
    expect(cli).toContain("let codexStdioRecordedThreadId: string | null = SESSION_ID || null;");
    const ensure = cli.slice(cli.indexOf("async function ensureCodexStdio("), start);
    expect(ensure).toContain("codexStdioThreadId = null;");
    expect(ensure).not.toContain("codexStdioRecordedThreadId");
  });

  test("no hard-coded app-server full-access literal remains in cli.ts", () => {
    expect(cli).not.toMatch(/sandboxPolicy:\s*\{\s*type:\s*"dangerFullAccess"/);
  });
});

// #553 — a fake JSON-RPC peer that answers like the real app-server did
// (0.133.0 / 0.155.1 measurements in codex-sdk-thread-options.ts).
function fakeAppServer(opts: { threads?: string[]; resumeError?: string; resumeAnswersWith?: string } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const known = new Set(opts.threads ?? []);
  let n = 0;
  return {
    calls,
    async request<R>(method: string, params?: unknown): Promise<R> {
      calls.push({ method, params });
      if (method === "thread/start") {
        const id = `0199aaaa-0000-7000-8000-00000000000${++n}`;
        return { thread: { id } } as R;
      }
      if (method === "thread/resume") {
        const id = (params as { threadId: string }).threadId;
        if (opts.resumeError) throw new Error(opts.resumeError);
        if (!known.has(id)) throw new Error(`codex JSON-RPC error -32600: no rollout found for thread id ${id}`);
        return { thread: { id: opts.resumeAnswersWith ?? id } } as R;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("#553 direct-stdio lane resumes the recorded thread", () => {
  const T = "0199bbbb-1111-7000-8000-000000000553";

  test("resume params carry threadId + the node's sandbox/approval, like thread/start", () => {
    expect(buildCodexStdioThreadResumeParams({ sandboxMode: "read-only", approvalPolicy: "never" }, "o3", T)).toEqual({
      threadId: T,
      model: "o3",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const unconfigured = buildCodexStdioThreadResumeParams(undefined, "m", T) as unknown as Record<string, unknown>;
    expect(unconfigured).toEqual({ threadId: T, model: "m", approvalPolicy: "on-request" });
    expect("sandboxPolicy" in unconfigured).toBe(false);
  });

  test("a recorded thread is resumed with thread/resume and thread/start is never sent", async () => {
    const rpc = fakeAppServer({ threads: [T] });
    const got = await openCodexStdioThread(rpc, {
      recordedThreadId: T,
      flags: { sandboxMode: "workspace-write", approvalPolicy: "never" },
      model: "m",
      alias: "n1",
    });
    expect(got).toEqual({ threadId: T, resumed: true });
    expect(rpc.calls.map((c) => c.method)).toEqual(["thread/resume"]);
    expect(rpc.calls[0].params).toEqual({ threadId: T, model: "m", approvalPolicy: "never", sandbox: "workspace-write" });
  });

  test("no recorded thread → thread/start, with no threadId", async () => {
    for (const recordedThreadId of [undefined, null, ""]) {
      const rpc = fakeAppServer();
      const got = await openCodexStdioThread(rpc, { recordedThreadId, flags: {}, model: "m", alias: "n1" });
      expect(got.resumed).toBe(false);
      expect(rpc.calls.map((c) => c.method)).toEqual(["thread/start"]);
      expect("threadId" in rpc.calls[0].params).toBe(false);
    }
  });

  test("a recorded thread with no rollout fails with one actionable line and never starts a fresh thread", async () => {
    const rpc = fakeAppServer({ threads: [] });
    let err: unknown;
    try {
      await openCodexStdioThread(rpc, { recordedThreadId: T, flags: {}, model: "m", alias: "n1", configPath: "/x/config.json" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexStdioResumeError);
    const msg = (err as Error).message;
    expect(msg.split("\n")).toHaveLength(1);
    expect(msg).toContain(`recorded codex thread ${T} cannot be resumed`);
    expect(msg).toContain("no rollout found");
    expect(msg).toContain("refusing to start a fresh thread");
    expect(msg).toContain("anet resume n1 --pick");
    expect(msg).toContain('remove "session" from /x/config.json');
    expect(rpc.calls.map((c) => c.method)).toEqual(["thread/resume"]);
  });

  test("any other resume failure (timeout / app-server exit) also fails without a fresh thread", async () => {
    const rpc = fakeAppServer({ threads: [T], resumeError: "codex request 'thread/resume' (id=2) timed out after 60000ms" });
    await expect(openCodexStdioThread(rpc, { recordedThreadId: T, flags: {}, model: "m", alias: "n1" })).rejects.toThrow(
      /thread\/resume of recorded thread .* failed \(codex request 'thread\/resume' .*timed out.*\) — not starting a fresh thread/,
    );
    expect(rpc.calls.map((c) => c.method)).toEqual(["thread/resume"]);
  });

  test("an app-server that answers resume with a different thread is refused", async () => {
    const rpc = fakeAppServer({ threads: [T], resumeAnswersWith: "0199cccc-0000-7000-8000-000000000000" });
    await expect(openCodexStdioThread(rpc, { recordedThreadId: T, flags: {}, model: "m", alias: "n1" })).rejects.toThrow(
      /answered with thread 0199cccc/,
    );
  });

  test("codex's measured thread-gone wordings are recognised (0.133 + 0.155)", () => {
    expect(isCodexThreadGoneError("codex JSON-RPC error -32600: no rollout found for thread id 019a0000-0000-7000-8000-000000000000")).toBe(true);
    expect(isCodexThreadGoneError("codex JSON-RPC error -32600: invalid thread id: invalid character")).toBe(true);
    expect(isCodexThreadGoneError("codex JSON-RPC error -32600: invalid session id: invalid character")).toBe(true);
    expect(isCodexThreadGoneError("codex app-server exited (code=1 signal=null)")).toBe(false);
  });

  test("the refusal is one line even when codex's message has newlines", () => {
    const line = codexStdioResumeRefusal({ alias: "a", threadId: T, cause: "no rollout found for thread id x\n  at y" });
    expect(line.includes("\n")).toBe(false);
  });
});
