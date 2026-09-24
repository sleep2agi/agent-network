// Startup `thread/resume` deadline: slow-but-in-budget resumes succeed, a
// timeout retries once and then fails loudly WITHOUT falling back to a new
// thread, and ANET_CODEX_RESUME_TIMEOUT_MS is parsed strictly.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerClient } from "../codex-app-server-client";
import { CodexAppServerBridge, CodexResumeTimeoutError } from "../codex-app-server-bridge";
import { openCodexAppServerRuntime } from "./runtime";
import {
  DEFAULT_RESUME_TIMEOUT_MS,
  RESUME_TIMEOUT_ENV,
  resetResumeTimeoutWarnings,
  resolveResumeTimeoutMs,
} from "./resume-timeout";

type Msg = { id: number; method: string; params?: unknown };
type Respond = (r: { result?: unknown; error?: { code: number; message: string } }) => void;

/** Minimal fake `codex app-server`; `resume(n, respond)` decides the n-th thread/resume. */
function fakeApp(resume: (n: number, respond: Respond) => void) {
  const methods: string[] = [];
  let resumes = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Msg;
        if (typeof msg.id !== "number") return;
        methods.push(msg.method);
        const respond: Respond = (r) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...r }));
        if (msg.method === "initialize") return respond({ result: {} });
        if (msg.method === "thread/resume") return resume(++resumes, respond);
        if (msg.method === "thread/start") return respond({ result: { threadId: "thread_NEW" } });
        if (msg.method === "thread/read") return respond({ result: { thread: { id: "thread_OLD", turns: [] } } });
        respond({ result: {} });
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, methods, stop: () => server.stop(true) };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env[RESUME_TIMEOUT_ENV];
  resetResumeTimeoutWarnings();
});

async function bridgeFor(url: string, opts: { resumeTimeoutMs?: number; resumeAttempts?: number } = {}) {
  const client = new CodexAppServerClient({ url });
  await client.connect();
  cleanups.push(() => client.close().catch(() => undefined));
  const bridge = new CodexAppServerBridge({ client, threadId: "thread_OLD", ...opts });
  const events: Array<Record<string, unknown>> = [];
  bridge.on("resume_timeout", (e) => events.push(e));
  const ready: Array<Record<string, unknown>> = [];
  bridge.on("thread_ready", (e) => ready.push(e));
  return { client, bridge, events, ready };
}

describe("startup thread/resume deadline", () => {
  test("a slow resume inside the budget succeeds and keeps the thread", async () => {
    const app = fakeApp((_n, respond) => setTimeout(() => respond({ result: {} }), 300));
    cleanups.push(app.stop);
    const { bridge, events, ready } = await bridgeFor(app.url, { resumeTimeoutMs: 2_000 });
    await bridge.bootstrap();
    expect(bridge.getThreadId()).toBe("thread_OLD");
    expect(events).toEqual([]);
    expect(ready[0].created).toBe(false);
    expect(ready[0].resumeMs as number).toBeGreaterThanOrEqual(250);
    expect(app.methods.filter((m) => m === "thread/start")).toEqual([]);
  });

  test("a timed-out resume retries once and succeeds on the loaded thread", async () => {
    // First resume never answers (still replaying the rollout); second answers.
    const app = fakeApp((n, respond) => { if (n >= 2) respond({ result: {} }); });
    cleanups.push(app.stop);
    const { bridge, events } = await bridgeFor(app.url, { resumeTimeoutMs: 150 });
    await bridge.bootstrap();
    expect(bridge.getThreadId()).toBe("thread_OLD");
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ threadId: "thread_OLD", attempt: 1, attempts: 2, timeoutMs: 150 });
    expect(app.methods.filter((m) => m === "thread/resume").length).toBe(2);
    expect(app.methods).not.toContain("thread/start");
  });

  test("resume timing out on every attempt fails loudly and never starts a new thread", async () => {
    const app = fakeApp(() => { /* never answers */ });
    cleanups.push(app.stop);
    const { bridge, events } = await bridgeFor(app.url, { resumeTimeoutMs: 100 });
    const err = await bridge.bootstrap().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CodexResumeTimeoutError);
    expect(String(err.message)).toContain("thread_OLD");
    expect(String(err.message)).toContain(RESUME_TIMEOUT_ENV);
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
    // Falling back to thread/start would silently drop the thread's history.
    expect(app.methods).not.toContain("thread/start");
    expect(bridge.currentStatus()).not.toBe("idle");
  });

  test("the bridge default is 120 s, not the client's generic 30 s", async () => {
    const app = fakeApp((_n, respond) => respond({ result: {} }));
    cleanups.push(app.stop);
    const { client, bridge } = await bridgeFor(app.url);
    const timeouts: Array<number | undefined> = [];
    const original = client.request.bind(client);
    client.request = ((method: string, params?: unknown, timeoutMs?: number) => {
      if (method === "thread/resume") timeouts.push(timeoutMs);
      return original(method, params, timeoutMs);
    }) as typeof client.request;
    await bridge.bootstrap();
    expect(timeouts).toEqual([DEFAULT_RESUME_TIMEOUT_MS]);
    expect(DEFAULT_RESUME_TIMEOUT_MS).toBe(120_000);
  });

  test("non-timeout resume errors are not retried", async () => {
    const app = fakeApp((_n, respond) => respond({ error: { code: -32000, message: "boom" } }));
    cleanups.push(app.stop);
    const { bridge, events } = await bridgeFor(app.url, { resumeTimeoutMs: 100 });
    const err = await bridge.bootstrap().then(() => null, (e) => e);
    expect(err).not.toBeInstanceOf(CodexResumeTimeoutError);
    expect(events).toEqual([]);
    expect(app.methods.filter((m) => m === "thread/resume").length).toBe(1);
  });
});

describe("runtime wiring", () => {
  test("ANET_CODEX_RESUME_TIMEOUT_MS reaches the bridge and each timeout is logged with the thread id", async () => {
    const app = fakeApp(() => { /* never answers */ });
    cleanups.push(app.stop);
    process.env[RESUME_TIMEOUT_ENV] = "120";
    const warns: string[] = [];
    const t0 = Date.now();
    const err = await openCodexAppServerRuntime({
      serverUrl: app.url, threadId: "thread_OLD", log: () => {}, warn: (m) => warns.push(m),
    }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CodexResumeTimeoutError);
    expect(Date.now() - t0).toBeLessThan(5_000); // 2 x 120 ms, not 2 x 120 s
    const lines = warns.filter((w) => w.includes("thread/resume"));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("thread=thread_OLD");
    expect(lines[0]).toContain("attempt 1/2 timed out after 120ms");
    expect(lines[0]).toContain("retrying");
    expect(lines[1]).toContain("giving up");
  });
});

describe("resolveResumeTimeoutMs", () => {
  test("unset or blank → default", () => {
    expect(resolveResumeTimeoutMs({}, () => {})).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    expect(resolveResumeTimeoutMs({ [RESUME_TIMEOUT_ENV]: "  " }, () => {})).toBe(DEFAULT_RESUME_TIMEOUT_MS);
  });

  test("whole milliseconds are honoured, including the timer maximum", () => {
    expect(resolveResumeTimeoutMs({ [RESUME_TIMEOUT_ENV]: "300000" }, () => {})).toBe(300_000);
    expect(resolveResumeTimeoutMs({ [RESUME_TIMEOUT_ENV]: " 1 " }, () => {})).toBe(1);
    expect(resolveResumeTimeoutMs({ [RESUME_TIMEOUT_ENV]: String(2 ** 31 - 1) }, () => {})).toBe(2 ** 31 - 1);
  });

  test("invalid values fall back to the default with one warning per distinct value", () => {
    const warns: string[] = [];
    for (const bad of ["abc", "0", "-5", "1.5", "2m", "1e5", String(2 ** 31), "abc"]) {
      expect(resolveResumeTimeoutMs({ [RESUME_TIMEOUT_ENV]: bad }, (m) => warns.push(m))).toBe(DEFAULT_RESUME_TIMEOUT_MS);
    }
    expect(warns.length).toBe(7);
    expect(warns[0]).toContain(`${RESUME_TIMEOUT_ENV}="abc"`);
  });
});

describe("cli startup failure path", () => {
  test("reports the node offline before exiting, since it already registered", () => {
    const src = readFileSync(join(import.meta.dir, "../../cli.ts"), "utf8");
    const start = src.indexOf("shared bridge startup failed");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf("process.exit(1)", start) + 1);
    expect(block).toContain('await reportStatus("offline")');
  });
});
