// P1b unit tests for per-goal codex wake.
//
// The Codex SDK is injected via `CodexWakeDeps.newCodex`, so every test
// passes a hand-rolled fake that yields exactly the events / errors the
// branch under test needs. Zero real-LLM dependency.

import { expect, test, describe } from "bun:test";
import type { AgentGoal } from "./types";
import {
  runCodexWakeForGoal,
  type CodexClientFake,
  type CodexThreadFake,
  type CodexEventFake,
  type CodexWakeDeps,
} from "./codex-wake";

function makeGoal(opts: { codex_thread_id?: string } = {}): AgentGoal {
  const now = new Date();
  return {
    goal_id: "test-goal-abcdef12",
    text: "test goal",
    status: "active",
    interval_ms: 60_000,
    next_wake_at: now.toISOString(),
    runtime: "codex-sdk",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    progress_log: [],
    codex_thread_id: opts.codex_thread_id,
  };
}

async function* streamEvents(events: CodexEventFake[]): AsyncIterable<CodexEventFake> {
  for (const ev of events) yield ev;
}

function agentMessageEvent(text: string): CodexEventFake {
  return { type: "item.completed", item: { type: "agent_message", text } };
}

function fakeThread(opts: {
  id?: string;
  events?: CodexEventFake[];
  runThrows?: Error;
}): CodexThreadFake {
  return {
    id: opts.id ?? null,
    runStreamed: async (_input: unknown) => {
      if (opts.runThrows) throw opts.runThrows;
      return { events: streamEvents(opts.events ?? [agentMessageEvent("ok")]) };
    },
  };
}

interface ClientFakeOpts {
  startThreadResult?: CodexThreadFake | (() => CodexThreadFake);
  resumeThreadResult?: CodexThreadFake | ((id: string) => CodexThreadFake);
  startThreadThrows?: Error;
  resumeThreadThrows?: Error;
}

function fakeClient(opts: ClientFakeOpts): CodexClientFake {
  return {
    startThread: (_o: unknown) => {
      if (opts.startThreadThrows) throw opts.startThreadThrows;
      const r = opts.startThreadResult;
      if (typeof r === "function") return r();
      return r ?? fakeThread({ id: "new-thread-id" });
    },
    resumeThread: (id: string, _o: unknown) => {
      if (opts.resumeThreadThrows) throw opts.resumeThreadThrows;
      const r = opts.resumeThreadResult;
      if (typeof r === "function") return r(id);
      return r ?? fakeThread({ id });
    },
  };
}

function deps(client: CodexClientFake): CodexWakeDeps {
  return {
    newCodex: () => client,
    buildOpts: () => ({ model: "test", approvalPolicy: "never" }),
    // Silent log/warn so test output stays clean.
    log: () => {},
    warn: () => {},
  };
}

describe("runCodexWakeForGoal — first wake (no codex_thread_id)", () => {
  test("startThread path → captures threadId, returns text + failed=false", async () => {
    const client = fakeClient({
      startThreadResult: fakeThread({ id: "fresh-thread-1", events: [agentMessageEvent("hello world")] }),
    });
    const r = await runCodexWakeForGoal(makeGoal(), "wake prompt", deps(client));
    expect(r.failed).toBe(false);
    expect(r.text).toBe("hello world");
    expect(r.threadId).toBe("fresh-thread-1");
    expect(r.threadRebuilt).toBe(false);
    expect(r.rebuildReason).toBeUndefined();
  });

  test("startThread with thread.id still null → threadId undefined (SDK didn't expose id yet)", async () => {
    const client = fakeClient({
      startThreadResult: fakeThread({ id: null, events: [agentMessageEvent("nothing")] }) as any,
    });
    // Force id to null (simulates SDK pre-thread.started). Cast via any
    // because the type allows string | null at the thread shape.
    const r = await runCodexWakeForGoal(makeGoal(), "wake", deps(client));
    expect(r.threadId).toBeUndefined();
    expect(r.failed).toBe(false);
  });

  test("empty agent_message stream → returns '(无回复)' fallback", async () => {
    const client = fakeClient({
      startThreadResult: fakeThread({ id: "id-1", events: [] }),
    });
    const r = await runCodexWakeForGoal(makeGoal(), "wake", deps(client));
    expect(r.text).toBe("（无回复）");
    expect(r.failed).toBe(false);
  });
});

describe("runCodexWakeForGoal — subsequent wake (has codex_thread_id)", () => {
  test("resumeThread succeeds → captures (possibly updated) threadId", async () => {
    const client = fakeClient({
      resumeThreadResult: (id) => fakeThread({ id, events: [agentMessageEvent("resumed-ok")] }),
    });
    const goal = makeGoal({ codex_thread_id: "existing-thread-xyz" });
    const r = await runCodexWakeForGoal(goal, "wake", deps(client));
    expect(r.failed).toBe(false);
    expect(r.text).toBe("resumed-ok");
    expect(r.threadId).toBe("existing-thread-xyz");
    expect(r.threadRebuilt).toBe(false);
    expect(r.rebuildReason).toBeUndefined();
  });

  test("resume returns thread whose .id was updated by SDK → reflects new id", async () => {
    const client = fakeClient({
      resumeThreadResult: () => fakeThread({ id: "new-rotated-id", events: [agentMessageEvent("ok")] }),
    });
    const goal = makeGoal({ codex_thread_id: "old-id" });
    const r = await runCodexWakeForGoal(goal, "wake", deps(client));
    expect(r.threadId).toBe("new-rotated-id");
  });
});

describe("runCodexWakeForGoal — resume-fail fallback (the critical path)", () => {
  test("resumeThread throws → startThread fallback, threadRebuilt=true, rebuildReason populated", async () => {
    const client = fakeClient({
      resumeThreadThrows: new Error("thread not found"),
      startThreadResult: fakeThread({ id: "rebuilt-thread-id", events: [agentMessageEvent("after rebuild")] }),
    });
    const goal = makeGoal({ codex_thread_id: "expired-id" });
    const r = await runCodexWakeForGoal(goal, "wake prompt with goal text", deps(client));
    expect(r.failed).toBe(false);
    expect(r.text).toBe("after rebuild");
    expect(r.threadId).toBe("rebuilt-thread-id");
    expect(r.threadRebuilt).toBe(true);
    expect(r.rebuildReason).toMatch(/resumeThread failed/);
    expect(r.rebuildReason).toMatch(/thread not found/);
  });

  test("startThread fallback also throws → failed=true with both errors surfaced", async () => {
    const client = fakeClient({
      resumeThreadThrows: new Error("thread expired"),
      startThreadThrows: new Error("codex binary missing"),
    });
    const goal = makeGoal({ codex_thread_id: "expired-id" });
    const r = await runCodexWakeForGoal(goal, "wake", deps(client));
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/startThread failed/);
    expect(r.text).toMatch(/codex binary missing/);
    expect(r.threadRebuilt).toBe(true);
    expect(r.rebuildReason).toMatch(/thread expired/);
  });

  test("first wake + startThread throws → failed=true, threadRebuilt=false", async () => {
    const client = fakeClient({
      startThreadThrows: new Error("codex not installed"),
    });
    const r = await runCodexWakeForGoal(makeGoal(), "wake", deps(client));
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/codex not installed/);
    expect(r.threadRebuilt).toBe(false);
    expect(r.rebuildReason).toBeUndefined();
  });
});

describe("runCodexWakeForGoal — run-time error after thread obtained", () => {
  test("runStreamed throws on first wake → failed=true, threadId still captured if SDK set it", async () => {
    const client = fakeClient({
      startThreadResult: fakeThread({ id: "obtained", runThrows: new Error("network reset mid-stream") }),
    });
    const r = await runCodexWakeForGoal(makeGoal(), "wake", deps(client));
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/network reset/);
    expect(r.threadId).toBe("obtained");
    expect(r.threadRebuilt).toBe(false);
  });

  test("runStreamed throws on resume → failed=true, threadRebuilt=false (resume itself worked)", async () => {
    const client = fakeClient({
      resumeThreadResult: (id) => fakeThread({ id, runThrows: new Error("LLM 5xx") }),
    });
    const goal = makeGoal({ codex_thread_id: "good-id" });
    const r = await runCodexWakeForGoal(goal, "wake", deps(client));
    expect(r.failed).toBe(true);
    expect(r.text).toMatch(/LLM 5xx/);
    expect(r.threadId).toBe("good-id");
    expect(r.threadRebuilt).toBe(false);
    expect(r.rebuildReason).toBeUndefined();
  });
});

describe("runCodexWakeForGoal — DI plumbing", () => {
  test("newCodex called per wake (not cached across wakes — fresh client each time)", async () => {
    let calls = 0;
    const deps2: CodexWakeDeps = {
      newCodex: () => {
        calls++;
        return fakeClient({}) ;
      },
      buildOpts: () => ({}),
    };
    await runCodexWakeForGoal(makeGoal(), "wake1", deps2);
    expect(calls).toBe(1);
    await runCodexWakeForGoal(makeGoal(), "wake2", deps2);
    expect(calls).toBe(2);
  });

  test("buildOpts passed verbatim to start/resume Thread", async () => {
    const seen: unknown[] = [];
    const sentinel = { I_AM: "the opts", model: "codex-test" };
    const client: CodexClientFake = {
      startThread: (o) => { seen.push(o); return fakeThread({ id: "x" }); },
      resumeThread: (_id, o) => { seen.push(o); return fakeThread({ id: "x" }); },
    };
    const d: CodexWakeDeps = {
      newCodex: () => client,
      buildOpts: () => sentinel,
    };
    // First wake: startThread receives opts
    await runCodexWakeForGoal(makeGoal(), "w", d);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(sentinel);
    // Resume: resumeThread receives opts
    await runCodexWakeForGoal(makeGoal({ codex_thread_id: "id" }), "w", d);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(sentinel);
  });

  test("warn callback fires on resume-fail; log callback fires on success", async () => {
    const warns: string[] = [];
    const logs: string[] = [];
    const client = fakeClient({
      resumeThreadThrows: new Error("bad"),
      startThreadResult: fakeThread({ id: "rebuilt", events: [agentMessageEvent("ok")] }),
    });
    const d: CodexWakeDeps = {
      newCodex: () => client,
      buildOpts: () => ({}),
      log: (m) => { logs.push(m); },
      warn: (m) => { warns.push(m); },
    };
    await runCodexWakeForGoal(makeGoal({ codex_thread_id: "x" }), "w", d);
    expect(warns.some((m) => /resumeThread failed/.test(m))).toBe(true);
    expect(logs.some((m) => /startThread/.test(m))).toBe(true);
  });

  test("missing log/warn deps → no throw (defaults are noops)", async () => {
    const client = fakeClient({});
    const d: CodexWakeDeps = {
      newCodex: () => client,
      buildOpts: () => ({}),
      // no log, no warn
    };
    const r = await runCodexWakeForGoal(makeGoal(), "w", d);
    expect(r.failed).toBe(false);
  });
});
