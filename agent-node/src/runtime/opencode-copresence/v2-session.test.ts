// Board #543 — OpenCode V2 co-presence core: turn-boundary reply matching,
// provider errors, human steer, queue withdrawal. The real binary is covered
// by tests/test543-opencode-v2-copresence (Docker, @opencode/cli 2.0.22 +
// stub model); here a protocol-shaped fake (fixtures/fake-opencode-v2.ts)
// stands in for `opencode serve`.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { readOpenCodeV2CatalogEndpoint } from "../opencode-v2-catalog-endpoint";
import { OPENCODE_V2_BACKEND } from "../opencode-backend";
import { openSharedV2CommhubMcp } from "./shared-v2-mcp";
import { OpenCodeProviderError } from "../opencode-provider-error";
import { OpenCodeCopresenceTimeoutError, openVettedOpenCodeCopresence, reserveLoopbackPort, type OpenCodeCopresenceSession } from "./runtime";
import {
  openCodeV2Outcome,
  openCodeV2ReplyText,
  openCodeV2SessionModelRef,
  openCodeV2TurnVerdict,
  wireOpenCodeV2CommhubMcp,
  type OpenCodeV2Entry,
} from "./v2-session";

const FAKE = join(import.meta.dir, "fixtures", "fake-opencode-v2.ts");
const noTmux = () => { throw new Error("tmux must not be touched by this test"); };

describe("session model ref (pure)", () => {
  test("providerID + id, nothing else", () => {
    expect(openCodeV2SessionModelRef({ data: { model: { providerID: "deepseek", id: "deepseek-flash" } } })).toBe("deepseek/deepseek-flash");
    expect(openCodeV2SessionModelRef({ data: { model: { providerID: "deepseek" } } })).toBeUndefined();
    expect(openCodeV2SessionModelRef({ data: { model: { providerID: "a/b", id: "c" } } })).toBeUndefined();
    expect(openCodeV2SessionModelRef({ model: { providerID: "deepseek", id: "flash" } })).toBeUndefined();
    expect(openCodeV2SessionModelRef(null)).toBeUndefined();
  });
});

describe("turn verdict (pure)", () => {
  test("pending until an idle marker or the next user entry", () => {
    expect(openCodeV2TurnVerdict([])).toEqual({ state: "pending" });
    expect(openCodeV2TurnVerdict([{ type: "assistant", finish: "stop" }])).toEqual({ state: "pending" });
    expect(openCodeV2TurnVerdict([{ type: "agent-switched" }, { type: "assistant" }])).toEqual({ state: "pending" });
  });

  test("idle closes the segment; a delivered queued user entry closes it too (no idle between)", () => {
    const a: OpenCodeV2Entry = { type: "assistant", content: [{ type: "text", text: "Q1" }], finish: "stop" };
    expect(openCodeV2TurnVerdict([a, { type: "idle", outcome: "succeeded" }]))
      .toEqual({ state: "done", closedBy: "idle", assistants: [a], idleOutcome: "succeeded" });
    expect(openCodeV2TurnVerdict([a, { type: "user", text: "Q2" }, { type: "assistant" }, { type: "idle" }]))
      .toEqual({ state: "done", closedBy: "user", assistants: [a] });
  });

  test("reply text = last assistant's text parts; never empty", () => {
    expect(openCodeV2ReplyText([{ content: [{ type: "reasoning", text: "x" }, { type: "text", text: " A " }, { type: "text", text: "B" }] }])).toBe("A B");
    expect(openCodeV2ReplyText([{ content: [{ type: "tool" }] }])).toBe("[opencode: assistant responded with tool (no text)]");
    expect(openCodeV2ReplyText([])).toBe("[opencode: assistant returned no reply]");
  });

  test("provider error → OpenCodeProviderError with the upstream text (#540 parity)", () => {
    const verdict = openCodeV2TurnVerdict([
      { type: "assistant", content: [], finish: "error", error: { type: "provider.invalid-request", message: "nope 400", status: 400 } },
      { type: "idle", outcome: "failed" },
    ]);
    if (verdict.state !== "done") throw new Error("expected done");
    let caught: unknown;
    try { openCodeV2Outcome(verdict, "msg_1"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OpenCodeProviderError);
    expect((caught as OpenCodeProviderError).upstreamName).toBe("provider.invalid-request");
    expect((caught as OpenCodeProviderError).upstreamMessage).toBe("nope 400");
  });

  test("a user entry before our final answer = human steered in → ownership refused, text carried", () => {
    const verdict = openCodeV2TurnVerdict([
      { type: "assistant", content: [{ type: "text", text: "partial" }], finish: "tool-calls" },
      { type: "user", text: "human" },
    ]);
    if (verdict.state !== "done") throw new Error("expected done");
    expect(() => openCodeV2Outcome(verdict, "msg_1")).toThrow(/not owned by the submitted network message/);
    try { openCodeV2Outcome(verdict, "msg_1"); } catch (error: any) {
      expect(error.unverifiedReplyText).toBe("partial");
      expect(error.submittedMessageId).toBe("msg_1");
    }
  });

  test("idle outcome other than succeeded without an error entry is a failure, not a reply", () => {
    const verdict = openCodeV2TurnVerdict([{ type: "idle", outcome: "failed" }]);
    if (verdict.state !== "done") throw new Error("expected done");
    expect(() => openCodeV2Outcome(verdict, "msg_1")).toThrow(/outcome=failed/);
  });
});

describe("CommHub MCP wiring (V2 native mcp.servers shape)", () => {
  test("adds mcp.servers.commhub with an {env:} bearer and the instructions file; keeps the policy", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-543-mcp-"));
    try {
      const env: NodeJS.ProcessEnv = { PWD: root, XDG_DATA_HOME: root, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "allow" }, model: "p/m" }) };
      const handle = wireOpenCodeV2CommhubMcp(env, { url: "http://127.0.0.1:9/mcp", token: "ntok_x", alias: "a" });
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      expect(config.mcp.servers.commhub).toEqual({
        type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false,
        headers: { Authorization: "Bearer {env:ANET_OPENCODE_COMMHUB_TOKEN}" },
      });
      expect(config.permission).toEqual({ "*": "allow" });
      expect(config.model).toBe("p/m");
      expect(config.instructions).toEqual([handle.path]);
      expect(config.plugins).toHaveLength(1);
      expect(readFileSync(join(config.plugins[0].package, "index.js"), "utf8")).toContain("ctx.tool.list()");
      expect(statSync(config.plugins[0].package).mode & 0o777).toBe(0o700);
      expect(env.ANET_OPENCODE_COMMHUB_TOKEN).toBe("ntok_x");
      expect(JSON.stringify(config)).not.toContain("ntok_x");
      expect(() => wireOpenCodeV2CommhubMcp({ ...env }, { url: "http://u:p@127.0.0.1/mcp", token: "t" })).toThrow(/credential-free/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("V2 core against a protocol-shaped fake serve", () => {
  let session: OpenCodeCopresenceSession | undefined;
  let root: string | undefined;
  afterEach(async () => {
    await session?.close().catch(() => {});
    session = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function open(extraEnv: NodeJS.ProcessEnv = {}, startupTimeoutMs = 10_000) {
    root = mkdtempSync(join(tmpdir(), "anet-543-core-"));
    const binary = join(root, "fake-opencode-v2.ts");
    copyFileSync(FAKE, binary);
    chmodSync(binary, 0o755);
    const warnings: string[] = [];
    session = await openVettedOpenCodeCopresence({
      backend: OPENCODE_V2_BACKEND,
      binary,
      env: { PATH: process.env.PATH ?? "", HOME: root, ...extraEnv },
      cwd: root,
      workDir: root,
      model: "stub/stub-model",
      startupTimeoutMs,
      tmuxRunner: noTmux,
      tmuxRespawn: noTmux,
      warn: (m) => warnings.push(m),
    });
    return { session, warnings };
  }

  test("MCP readiness failure creates no session/attach script and reaps serve", async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), "anet-832-trace-"));
    const trace = join(traceRoot, "requests");
    try {
      await expect(open({ TEST832_TRACE: trace, TEST832_MISSING: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers: { commhub: {} } } }) }, 250)).rejects.toThrow("readiness timed out");
      expect(existsSync(join(root!, "opencode-attach.sh"))).toBe(false);
      const requests = readFileSync(trace, "utf8");
      expect(requests).toContain("/api/rpc/anet.commhub-readiness/ready");
      expect(requests).not.toContain("/api/session");
      expect(existsSync(join(root!, "opencode-v2-catalog-endpoint.json"))).toBe(false);
      const pid = Number(requests.split(" ")[0]);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { rmSync(traceRoot, { recursive: true, force: true }); }
  });

  test("rejects an unsupported server before creating a session", async () => {
    await expect(open({ TEST_INFO_VERSION: "2.0.99" })).rejects.toThrow(/server version 2\.0\.99/);
    expect(existsSync(join(root!, "opencode-attach.sh"))).toBe(false);
  });

  test("MCP observation precedes session and ready launcher; close reaps serve", async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), "anet-832-order-"));
    const trace = join(traceRoot, "requests");
    try {
      const { session } = await open({ TEST832_TRACE: trace,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers: { commhub: {} } } }) });
      const requests = readFileSync(trace, "utf8");
      expect(requests.indexOf("/api/rpc/anet.commhub-readiness/ready")).toBeLessThan(requests.indexOf("/api/session"));
      expect(existsSync(session.attachScriptPath)).toBe(true);
      expect(existsSync(join(root!, "opencode-v2-catalog-endpoint.json"))).toBe(true);
      await session.close();
      expect(existsSync(session.attachScriptPath)).toBe(false);
      expect(existsSync(join(root!, "opencode-v2-catalog-endpoint.json"))).toBe(false);
      expect(() => process.kill(Number(requests.split(" ")[0]), 0)).toThrow();
    } finally { rmSync(traceRoot, { recursive: true, force: true }); }
  });

  async function fake(path: string, init: RequestInit = {}) {
    const launcher = readFileSync(session!.attachScriptPath, "utf8");
    const password = /OPENCODE_SERVER_PASSWORD='([^']+)'/.exec(launcher)![1];
    return await fetch(`${session!.url}${path}`, {
      ...init,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
    });
  }

  test("ready: loopback, ses_ id, 0700 launcher that joins with --server/--session (no attach, no --pure)", async () => {
    const { session } = await open();
    const state = await (await fake("/test/state")).json() as any;
    expect(state[session.sessionId].location).toEqual({ directory: resolve(root!) });
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.sessionId).toMatch(/^ses_/);
    expect(statSync(session.attachScriptPath).mode & 0o777).toBe(0o700);
    const launcher = readFileSync(session.attachScriptPath, "utf8");
    expect(launcher).toContain(`--server '${session.url}' --session '${session.sessionId}'`);
    expect(launcher).not.toContain(" attach ");
    expect(launcher).not.toContain("--pure");
    const endpoint = readOpenCodeV2CatalogEndpoint(root!);
    const password = /OPENCODE_SERVER_PASSWORD='([^']+)'/.exec(launcher)![1]!;
    expect(statSync(join(root!, "opencode-v2-catalog-endpoint.json")).mode & 0o777).toBe(0o600);
    expect(endpoint?.url).toBe(session.url);
    expect(endpoint?.directory).toBe(resolve(root!));
    expect(endpoint?.authorization).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
    expect(JSON.stringify(endpoint)).not.toContain(password);
  });

  test("refuses a session created in a different workspace", async () => {
    await expect(open({ TEST_WRONG_LOCATION: "1" })).rejects.toThrow(/session directory does not match/);
    expect(existsSync(join(root!, "opencode-attach.sh"))).toBe(false);
    expect(existsSync(join(root!, "opencode-v2-catalog-endpoint.json"))).toBe(false);
  });

  test("two workspaces share one server but keep separate sessions; closing one leaves the server alive", async () => {
    root = mkdtempSync(join(tmpdir(), "anet-543-shared-"));
    const binary = join(root, "fake-opencode-v2.ts");
    copyFileSync(FAKE, binary);
    chmodSync(binary, 0o755);
    const port = await reserveLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const password = "test-only";
    const passwordFile = join(root, "server-password");
    writeFileSync(passwordFile, password, { mode: 0o600 });
    const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: root, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: "ignore",
    });
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    mkdirSync(firstDir); mkdirSync(secondDir);
    let first: OpenCodeCopresenceSession | undefined;
    let second: OpenCodeCopresenceSession | undefined;
    try {
      const openShared = (cwd: string, resumeSessionId?: string, model = "stub/stub-model", reconcileResumedModel = false) => openVettedOpenCodeCopresence({
        backend: OPENCODE_V2_BACKEND, binary, env: { PATH: process.env.PATH ?? "", HOME: root },
        cwd, workDir: cwd, model, sharedServer: { url, password, passwordFile }, resumeSessionId, reconcileResumedModel,
        tmuxRunner: noTmux, tmuxRespawn: noTmux,
      });
      first = await openShared(firstDir);
      second = await openShared(secondDir);
      const firstId = first.sessionId;
      expect(first.sessionId).not.toBe(second.sessionId);
      await expect(openShared(firstDir, "ses_MissingHistory")).rejects.toThrow(/refusing to create a new session/);
      const sessionsAfterMissing = await (await fetch(`${url}/test/state`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      })).json() as Record<string, unknown>;
      expect(Object.keys(sessionsAfterMissing)).toHaveLength(2);
      expect(existsSync(first.attachScriptPath)).toBe(true);
      expect(readOpenCodeV2CatalogEndpoint(firstDir)?.directory).toBe(resolve(firstDir));
      const launcher = readFileSync(first.attachScriptPath, "utf8");
      expect(launcher).not.toContain(password);
      expect(launcher).toContain(passwordFile);
      await first.close();
      first = undefined;
      expect(server.exitCode).toBeNull();
      const resumed = await openShared(firstDir, firstId);
      first = resumed;
      expect(resumed.sessionId).toBe(firstId);
      await first.close();
      await fetch(`${url}/api/session/${firstId}/model`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "stub", id: "tui-selected-model" } }),
      });
      first = await openShared(firstDir, firstId);
      expect(first.sessionId).toBe(firstId);
      expect(await first.selectedModel?.()).toBe("stub/tui-selected-model");
      await first.setSelectedModel?.("stub/client-selected");
      expect(await first.selectedModel?.()).toBe("stub/client-selected");
      let state = await (await fetch(`${url}/test/state`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      })).json() as any;
      expect(state[firstId].model).toEqual({ providerID: "stub", id: "tui-selected-model" });
      await first.close();
      first = await openShared(firstDir, firstId, "stub/new-model", true);
      expect(first.sessionId).toBe(firstId);
      state = await (await fetch(`${url}/test/state`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      })).json() as any;
      expect(state[firstId].model).toEqual({ providerID: "stub", id: "new-model" });
    } finally {
      await first?.close();
      await second?.close();
      server.kill("SIGTERM");
    }
  });

  test("shared server waits for workspace MCP and registered tools", async () => {
    root = mkdtempSync(join(tmpdir(), "anet-543-shared-ready-"));
    const binary = join(root, "fake-opencode-v2.ts");
    copyFileSync(FAKE, binary); chmodSync(binary, 0o755);
    const port = await reserveLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const password = "test-only";
    const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: root, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, TEST_REQUIRE_PROJECT_PLUGIN: "1" }, stdio: "ignore",
    });
    const cwd = join(root, "project"); mkdirSync(cwd);
    const workDir = join(root, "node-private"); mkdirSync(workDir, { mode: 0o700 });
    const proxy = await openSharedV2CommhubMcp(cwd, workDir, "http://127.0.0.1:9999/mcp", "test-node-token", join(cwd, "ANET-COMMHUB.md"));
    try {
      session = await openVettedOpenCodeCopresence({
        backend: OPENCODE_V2_BACKEND, binary, env: { PATH: process.env.PATH ?? "", HOME: root },
        cwd, workDir, model: "stub/stub-model", sharedServer: { url, password }, sharedMcpUrl: proxy.url,
        tmuxRunner: noTmux, tmuxRespawn: noTmux,
      });
      expect(session.sessionId).toMatch(/^ses_/);
    } finally {
      await session?.close(); session = undefined;
      await proxy.close();
      server.kill("SIGTERM");
    }
  });

  test("a network task gets its own reply, with sender provenance in the visible turn", async () => {
    const { session } = await open();
    const evidence: string[] = [];
    const out = await session.submit("Reply with exactly NET_ONE", 10_000, "peer-node", {
      onSubmitted: () => evidence.push("submitted"),
      onConsumed: () => evidence.push("consumed"),
    });
    expect(out.replyText).toBe("NET_ONE");
    expect(evidence).toEqual(["submitted", "consumed"]);
    const state = await (await fake("/test/state")).json() as any;
    const users = state[session.sessionId].entries.filter((e: any) => e.type === "user").map((e: any) => e.text);
    expect(users).toEqual(["[来自 peer-node] Reply with exactly NET_ONE"]);
  });

  test("back-to-back tasks each get their own answer (queued delivery has no idle between turns)", async () => {
    const { session } = await open();
    const [a, b] = await Promise.all([
      session.submit("DELAY_200 Reply with exactly AAA", 10_000),
      session.submit("Reply with exactly BBB", 10_000),
    ]);
    expect(a.replyText).toBe("AAA");
    expect(b.replyText).toBe("BBB");
  });

  test("board656 a tool then at capacity does not resubmit the turn", async () => {
    const { session } = await open();
    const sleeps: number[] = [];
    const error: any = await session.submit("STUB_TOOL_CAPACITY please", 10_000, undefined, {
      capacityRetrySleep: async (ms) => { sleeps.push(ms); },
      onCapacityRetry: () => { sleeps.push(-1); },
    }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(OpenCodeProviderError);
    expect(error.message).toContain("模型在执行中途出错，未自动重试，以免重复执行");
    expect(error.message).not.toContain("已自动重试");
    expect(sleeps).toEqual([]);
  });

  test("provider error fails the task with the upstream text instead of a false 'replied'", async () => {
    const { session } = await open();
    await expect(session.submit("STUB_FAIL please", 10_000)).rejects.toBeInstanceOf(OpenCodeProviderError);
    await expect(session.submit("STUB_FAIL please", 10_000)).rejects.toThrow(/stub provider refused: STUB_FAIL requested/);
    // …and the session keeps working afterwards.
    expect((await session.submit("Reply with exactly AFTER", 10_000)).replyText).toBe("AFTER");
  });

  test("a human steering into the running network turn → reply refused, text carried", async () => {
    const { session } = await open();
    const pending = session.submit("DELAY_400 Reply with exactly MINE", 10_000);
    await new Promise((r) => setTimeout(r, 150));
    expect((await fake(`/test/${session.sessionId}/steer`, { method: "POST", body: JSON.stringify({ text: "human words" }) })).ok).toBe(true);
    const error: any = await pending.then(() => null, (e) => e);
    expect(error?.ownershipReason).toMatch(/another user message was delivered into this turn/);
  });

  test("deadline while still queued behind a long turn → withdrawn from the inbox, 'admission' (never runs later)", async () => {
    const { session } = await open();
    const long = session.submit("DELAY_1500 Reply with exactly LONG", 10_000);
    // The core serialises network tasks; drive the queued-behind-a-human
    // shape directly: a foreign long turn occupies the session, then ours.
    void long;
    await new Promise((r) => setTimeout(r, 100));
    const blocked = await fake(`/api/session/${session.sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text: "DELAY_1500 human long turn", delivery: "queue" }) });
    expect(blocked.ok).toBe(true);
    await long;
    const error: any = await session.submit("Reply with exactly LATE", 600).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(OpenCodeCopresenceTimeoutError);
    expect(error.phase).toBe("admission");
    await new Promise((r) => setTimeout(r, 2_000));
    const state = await (await fake("/test/state")).json() as any;
    const texts = state[session.sessionId].entries.map((e: any) => e.text).filter(Boolean);
    expect(texts.some((t: string) => t.includes("LATE"))).toBe(false);
  });

  test("notify is logged, not thrown (V2 has no TUI toast route) — so the message is acked, not retried forever", async () => {
    const { session, warnings } = await open();
    await session.notify("hello", 1_000, "peer");
    await session.notify("again", 1_000, "peer");
    expect(warnings.filter((w) => /no TUI notification channel/.test(w))).toHaveLength(1);
  });

  test("close stops serve and removes the launcher", async () => {
    const { session: s } = await open();
    const launcher = s.attachScriptPath;
    await s.close();
    expect(s.isRunning).toBe(false);
    expect(existsSync(launcher)).toBe(false);
    session = undefined;
  });
});
