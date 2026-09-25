import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { runtimeErrorReplyText } from "../unverified-reply-text";
import {
  linuxProcessGroupIsGone,
  readLinuxProcessGroupIdentity,
  sameLinuxProcessGroupIdentity,
  signalExactLinuxProcessGroup,
} from "./process-group";
import {
  OPENCODE_COMMHUB_TOKEN_ENV,
  OpenCodeCopresenceTimeoutError,
  openVettedOpenCodeCopresence,
  parseMessageReply,
  requireOpenCodeCopresenceModel,
  wireOpenCodeCommhubMcp,
  writeOpenCodeCommhubInstructions,
  removeOwnOpenCodeCommhubInstructions,
  renderOpenCodeCommhubInstructions,
  wireOpenCodeDefaultModel,
} from "./runtime";

const FAKE = `#!/usr/bin/env node
const http = require("http");
const { argv, env } = process;
const args = argv.slice(2);
const command = args[0];
const value = (flag) => args[args.indexOf(flag) + 1];
const expectedAuth = "Basic " + Buffer.from((env.OPENCODE_SERVER_USERNAME || "opencode") + ":" + env.OPENCODE_SERVER_PASSWORD).toString("base64");
if (command === "serve") {
  const port = Number(value("--port"));
  const statuses = {};
  const messages = {};
  let lastResponse = null;
  const trace = (line) => { if (env.FAKE_LOG) require("fs").appendFileSync(env.FAKE_LOG, line + "\\n"); };
  const server = http.createServer(async (req, res) => {
    trace(req.method + " " + req.url);
    if (req.headers.authorization !== expectedAuth) { res.writeHead(401); return res.end("unauthorized"); }
    const body = await new Promise((resolve) => { let s=""; req.on("data", c => s+=c); req.on("end", () => resolve(s)); });
    const json = body ? JSON.parse(body) : {};
    if (req.url === "/global/health") return send(res, { healthy:true, version:"1.18.1" });
    if (req.url === "/session/status") return send(res, statuses);
    if (req.url === "/session" && req.method === "POST") {
      const id = "ses_test123";
      messages[id] = [];
      const busyMs = Number(env.FAKE_INITIAL_BUSY_MS || 0);
      if (busyMs > 0) { statuses[id] = { type:"busy" }; setTimeout(() => delete statuses[id], busyMs); }
      return send(res, { id, title:json.title });
    }
    const sessionMatch = req.url.match(/^\\/session\\/(ses_[A-Za-z0-9]+)$/);
    if (sessionMatch && req.method === "GET") {
      if (env.FAKE_SESSION_LOOKUP_MISSING === "1" || !messages[sessionMatch[1]]) {
        res.writeHead(404); return res.end("session not found");
      }
      return send(res, { id:sessionMatch[1] });
    }
    if (req.url === "/tui/show-toast" && req.method === "POST") {
      const expectedSender = env.FAKE_EXPECT_NOTICE_SENDER || "";
      const expectedTitle = expectedSender
        ? "Agent Network · 来自 " + expectedSender
        : "Agent Network message";
      const expectedPrefix = expectedSender
        ? "[来自 " + expectedSender + "] notice:"
        : "notice:";
      if (json.title !== expectedTitle || json.variant !== "info" || json.duration !== 15000) {
        res.writeHead(400); return res.end("invalid notification toast");
      }
      if (!(json.message || "").startsWith(expectedPrefix)) {
        res.writeHead(400); return res.end("missing notification message");
      }
      return send(res, true);
    }
    const match = req.url.match(/^\\/session\\/(ses_[A-Za-z0-9]+)\\/message$/);
    if (match && req.method === "GET") return send(res, messages[match[1]] || []);
    if (match && req.method === "POST") {
      const id = match[1];
      if ((json.parts?.[0]?.text || "").startsWith("notice:") || json.noReply === true) {
        res.writeHead(400); return res.end("notifications must not enter session history");
      }
      if (env.FAKE_REQUIRE_MODEL === "1" && (json.model?.providerID !== "opencode" || json.model?.modelID !== "fake")) {
        res.writeHead(400); return res.end("missing model identity");
      }
      if (lastResponse && env.FAKE_REQUIRE_ASCENDING_MESSAGE_ID === "1" &&
          !/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(json.messageID || "")) {
        messages[id].push({ info:{role:"user",id:json.messageID}, parts:json.parts || [] });
        return send(res, lastResponse);
      }
      statuses[id] = { type:"busy" };
      // Real OpenCode records the user message before the runner starts; the
      // legacy fake records it at the end. FAKE_USER_FIRST opts into the real
      // order (the timeout path reads history to see whether it landed).
      if (env.FAKE_USER_FIRST === "1") messages[id].push({ info:{role:"user",id:json.messageID}, parts:json.parts || [] });
      // Like OpenCode 1.18.1, a client disconnect does not stop the turn.
      await new Promise(r => setTimeout(r, Number(env.FAKE_TURN_MS || 25)));
      const prompt = json.parts?.[0]?.text || "";
      const reply = "FAKE_REPLY:" + prompt;
      let parentID = json.messageID;
      if (env.FAKE_USER_FIRST !== "1") messages[id].push({ info:{role:"user",id:json.messageID}, parts:json.parts || [] });
      if (env.FAKE_RACE_HUMAN === "1") {
        // A human TUI turn won the idle-check -> POST race: it is in history
        // as a real text user message and the runner answered it.
        messages[id].push({ info:{role:"user",id:"msg_human_race"}, parts:[{type:"text",text:"human typed this"}] });
        parentID = "msg_human_race";
      }
      if (env.FAKE_COMPACT_MID_TURN === "1") {
        // Mid-turn compaction: a synthetic summary continuation parented to our
        // submission; the final assistant message is parented to the summary.
        messages[id].push({ info:{role:"user",id:"msg_summary_1",parentID:json.messageID,summary:true}, parts:[{type:"compaction"}] });
        parentID = "msg_summary_1";
      }
      lastResponse = { info:{role:"assistant",parentID}, parts:[{type:"text",text:reply}] };
      messages[id].push(lastResponse);
      delete statuses[id];
      trace("TURN_DONE " + prompt);
      return send(res, lastResponse);
    }
    res.writeHead(404); res.end("not found");
  });
  function send(res, value) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(value)); }
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (command === "run") {
  const base = value("--attach");
  const session = value("--session");
  const prompt = args.at(-1);
  fetch(base + "/session/" + session + "/message", {
    method:"POST",
    headers:{authorization:expectedAuth,"content-type":"application/json"},
    body:JSON.stringify({parts:[{type:"text",text:prompt}]})
  }).then(async r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    const value = await r.json();
    for (const part of value.parts || []) console.log(JSON.stringify({type:"text",part}));
  }).catch(e => { console.error(e.message); process.exitCode=1; });
} else if (args.includes("--version") || command === "--version") {
  console.log("1.18.1");
} else {
  console.error("unsupported fake command", args.join(" "));
  process.exit(2);
}
`;

function fixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "opencode-copresence-test-"));
  chmodSync(root, 0o700);
  const binary = join(root, "opencode");
  writeFileSync(binary, FAKE, { mode: 0o700 });
  return {
    root,
    binary,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      ...extraEnv,
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("OpenCode native serve+attach copresence", () => {
  test("requires an explicit provider/model for production copresence", () => {
    expect(() => requireOpenCodeCopresenceModel(undefined)).toThrow("explicit provider/model");
    expect(() => requireOpenCodeCopresenceModel("  ")).toThrow("explicit provider/model");
    expect(requireOpenCodeCopresenceModel("opencode/north-mini-code-free"))
      .toBe("opencode/north-mini-code-free");
  });

  test("requires an explicit provider/model at the vetted launch seam too", async () => {
    const f = fixture();
    const outcome = await openVettedOpenCodeCopresence({
      binary: f.binary,
      env: f.env,
      cwd: f.root,
      workDir: f.root,
      startupTimeoutMs: 5_000,
    }).then(
      (session) => ({ session, error: undefined }),
      (error: unknown) => ({ session: undefined, error }),
    );
    try {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain("explicit provider/model");
    } finally {
      await outcome.session?.close();
      f.close();
    }
  }, 8_000);

  test("wires one token-bound CommHub MCP without reopening local tools", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-commhub-config-"));
    try {
      const configRoot = join(root, "config");
      const renderedConfigPath = join(configRoot, "opencode", "opencode.json");
      mkdirSync(join(configRoot, "opencode"), { recursive: true });
      writeFileSync(renderedConfigPath, JSON.stringify({
        permission: { "*": "deny", bash: "deny", apply_patch: "deny" },
        tools: { bash: false, apply_patch: false },
      }), { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        PWD: root,
        XDG_CONFIG_HOME: configRoot,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          tools: { bash: false, apply_patch: false },
          permission: { "*": "deny", bash: "deny", apply_patch: "deny" },
          mcp: {},
        }),
        OPENCODE_PERMISSION: JSON.stringify({ "*": "deny", bash: "deny", apply_patch: "deny" }),
      };
      wireOpenCodeCommhubMcp(env, {
        url: "http://127.0.0.1:9200/mcp",
        token: "ntok_test_secret",
        alias: "opencode-test",
      });
      wireOpenCodeDefaultModel(env, "opencode/north-mini-code-free");
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      const permission = JSON.parse(env.OPENCODE_PERMISSION!);
      expect(config.mcp.commhub).toEqual({
        type: "remote",
        url: "http://127.0.0.1:9200/mcp",
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer {env:${OPENCODE_COMMHUB_TOKEN_ENV}}` },
      });
      expect(config.tools.bash).toBe(false);
      expect(config.model).toBe("opencode/north-mini-code-free");
      expect(config.tools["commhub_*"]).toBe(true);
      expect(config.permission["*"]).toBeUndefined();
      expect(config.permission.apply_patch).toBe("deny");
      expect(config.tools.apply_patch).toBe(false);
      expect(permission["*"]).toBeUndefined();
      expect(permission.bash).toBe("deny");
      expect(permission["commhub_*"]).toBe("allow");
      expect(env[OPENCODE_COMMHUB_TOKEN_ENV]).toBe("ntok_test_secret");
      expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("ntok_test_secret");
      expect(readFileSync(config.instructions[0], "utf8")).toContain("opencode-test");
      expect(readFileSync(config.instructions[0], "utf8")).toContain("commhub_send_task");
      const rendered = JSON.parse(readFileSync(renderedConfigPath, "utf8"));
      expect(rendered.permission["*"]).toBeUndefined();
      expect(rendered.permission.bash).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1946 — stop/crash/exit-75 restart left the workspace ANET-COMMHUB.md
  // behind and the next start died on `wx` with EEXIST. Own-generation
  // files are overwritten; anything else still refuses.
  test("overwrites its own previous generation's ANET-COMMHUB.md instead of dying with EEXIST (#1946)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-commhub-1946-own-"));
    try {
      const path = join(root, "ANET-COMMHUB.md");
      writeFileSync(path, "You are Agent Network node opencode-test.\nSTALE BODY FROM A PREVIOUS GENERATION\n", { mode: 0o644 });
      const handle = writeOpenCodeCommhubInstructions(path, "opencode-test");
      expect(handle.path).toBe(path);
      expect(readFileSync(path, "utf8")).toBe(renderOpenCodeCommhubInstructions("opencode-test"));
      expect(readFileSync(path, "utf8")).not.toContain("STALE BODY");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still refuses an ANET-COMMHUB.md that names another node or was written by a human (#1946)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-commhub-1946-foreign-"));
    try {
      const path = join(root, "ANET-COMMHUB.md");
      const foreign = "You are Agent Network node someone-else.\nkeep me\n";
      writeFileSync(path, foreign, { mode: 0o600 });
      let code: string | undefined;
      try {
        writeOpenCodeCommhubInstructions(path, "opencode-test");
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code;
      }
      expect(code).toBe("EEXIST");
      expect(readFileSync(path, "utf8")).toBe(foreign);

      const human = "# my notes\nnot an agent file\n";
      writeFileSync(path, human, { mode: 0o600 });
      code = undefined;
      try {
        writeOpenCodeCommhubInstructions(path, "opencode-test");
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code;
      }
      expect(code).toBe("EEXIST");
      expect(readFileSync(path, "utf8")).toBe(human);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("close-time removal deletes exactly the bytes this generation wrote and nothing else (#1946)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-commhub-1946-remove-"));
    try {
      const path = join(root, "ANET-COMMHUB.md");
      const handle = writeOpenCodeCommhubInstructions(path, "opencode-test");
      expect(removeOwnOpenCodeCommhubInstructions(handle)).toBe(true);
      expect(existsSync(path)).toBe(false);
      // already gone → still true (idempotent on the crash+restart path)
      expect(removeOwnOpenCodeCommhubInstructions(handle)).toBe(true);
      // someone rewrote it after us → leave it, report false
      writeFileSync(path, "You are Agent Network node opencode-test.\nedited by a human\n", { mode: 0o600 });
      expect(removeOwnOpenCodeCommhubInstructions(handle)).toBe(false);
      expect(readFileSync(path, "utf8")).toContain("edited by a human");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses one authenticated loopback session for FIFO network turns and emits an owner-only attach launcher", async () => {
    const f = fixture({ FAKE_REQUIRE_MODEL: "1" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(runtime.sessionId).toBe("ses_test123");
      expect(runtime.isRunning).toBe(true);
      expect(existsSync(runtime.attachScriptPath)).toBe(true);
      expect(statSync(runtime.attachScriptPath).mode & 0o777).toBe(0o700);
      const launcher = readFileSync(runtime.attachScriptPath, "utf8");
      expect(launcher).toContain("opencode' attach");
      expect(launcher).toContain("--session 'ses_test123'");
      // #1957 — the launcher records itself so close() can stop exactly that TUI
      expect(launcher).toContain("export ANET_OPENCODE_ATTACH_GEN='ses_test123'");
      expect(launcher).toContain("opencode-attach.json");

      await runtime.notify("notice:dashboard-message", 5_000);

      const oneEvidence: string[] = [];
      const twoEvidence: string[] = [];
      const first = runtime.submit("one", 5_000, undefined, {
        onSubmitted: () => oneEvidence.push("submitted"),
        onConsumed: () => oneEvidence.push("consumed"),
      });
      const second = runtime.submit("two", 5_000, undefined, {
        onSubmitted: () => twoEvidence.push("submitted"),
        onConsumed: () => twoEvidence.push("consumed"),
      });
      // FIFO admission and idle checks are not runtime evidence.
      expect(oneEvidence).toEqual([]);
      expect(twoEvidence).toEqual([]);
      const [one, two] = await Promise.all([first, second]);
      expect(one.replyText).toBe("FAKE_REPLY:one");
      expect(two.replyText).toBe("FAKE_REPLY:two");
      expect(oneEvidence).toEqual(["submitted", "consumed"]);
      expect(twoEvidence).toEqual(["submitted", "consumed"]);
      expect(runtime.isRunning).toBe(true);
    } finally {
      await runtime?.close();
      if (runtime) {
        expect(runtime.isRunning).toBe(false);
        expect(existsSync(runtime.attachScriptPath)).toBe(false);
      }
      f.close();
    }
  }, 15_000);

  test("shows the network sender in both the toast title and message body", async () => {
    const f = fixture({ FAKE_EXPECT_NOTICE_SENDER: "通信牛" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      await runtime.notify("notice:sender-visible", 5_000, "通信牛");
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("shows the normalized network-task sender in the shared TUI turn", async () => {
    const f = fixture();
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      const result = await runtime.submit(
        "task:sender-visible",
        5_000,
        "\u0000  通信\n牛  ",
      );
      expect(result.replyText).toBe("FAKE_REPLY:[来自 通信 牛] task:sender-visible");
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("waits for an already-busy human session before injecting a network turn", async () => {
    const f = fixture({ FAKE_INITIAL_BUSY_MS: "350" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      const started = Date.now();
      const result = await runtime.submit("after-human", 5_000);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(result.replyText).toBe("FAKE_REPLY:after-human");
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("refuses a reply owned by a human turn that won the idle-to-submit race", async () => {
    const f = fixture({ FAKE_RACE_HUMAN: "1" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      let caught: any = null;
      try {
        await runtime.submit("network-must-own-its-reply", 5_000);
      } catch (error) {
        caught = error;
      }
      expect(caught?.message).toContain("not owned by the submitted network message");
      // #1910 floor: the refused answer must travel with the error, never vanish.
      expect(caught?.unverifiedReplyText).toBe("FAKE_REPLY:network-must-own-its-reply");
      expect(caught?.unverifiedParentId).toBe("msg_human_race");
      expect(typeof caught?.submittedMessageId).toBe("string");
      expect(caught?.ownershipReason).toContain("human message msg_human_race");
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("accepts a reply re-parented by a mid-turn compaction whose chain reaches the submitted message (#1910)", async () => {
    const f = fixture({ FAKE_COMPACT_MID_TURN: "1" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    const logs: string[] = [];
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
        log: (line) => logs.push(line),
      });
      const result = await runtime.submit("long-turn", 5_000);
      expect(result.replyText).toBe("FAKE_REPLY:long-turn");
      expect(logs.some((l) => l.includes("reply parent chain verified through 1 intermediate"))).toBe(true);
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("uses OpenCode's ascending message ID shape across sequential network turns", async () => {
    const f = fixture({ FAKE_REQUIRE_ASCENDING_MESSAGE_ID: "1" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      const first = await runtime.submit("first-network-turn", 5_000);
      const second = await runtime.submit("second-network-turn", 5_000);
      expect(first.replyText).toBe("FAKE_REPLY:first-network-turn");
      expect(second.replyText).toBe("FAKE_REPLY:second-network-turn");
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("does not treat a missing session status and missing session record as idle", async () => {
    const f = fixture({ FAKE_SESSION_LOOKUP_MISSING: "1" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
        model: "opencode/fake",
        startupTimeoutMs: 5_000,
      });
      await expect(runtime.submit("must-not-run", 250)).rejects.toThrow("remained busy");
    } finally {
      await runtime?.close();
      f.close();
    }
  }, 15_000);

  test("binds teardown authority to a detached pid, pgrp, and process start ticks", async () => {
    if (process.platform !== "linux") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    const current = readLinuxProcessGroupIdentity(child.pid!);
    try {
      expect(current).toBeDefined();
      expect(current!.pgrp).toBe(child.pid!);
      expect(sameLinuxProcessGroupIdentity(current!)).toBe(true);
      expect(sameLinuxProcessGroupIdentity({ ...current!, startTicks: `${current!.startTicks}0` })).toBe(false);
      expect(linuxProcessGroupIsGone({ ...current!, pgrp: current!.pgrp + 1 })).toBe(true);
      expect(signalExactLinuxProcessGroup(current!, "SIGTERM")).toBe(true);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(linuxProcessGroupIsGone(current!)).toBe(true);
    } finally {
      if (current && sameLinuxProcessGroupIdentity(current)) {
        signalExactLinuxProcessGroup(current, "SIGKILL");
      }
    }
  }, 5_000);
});

// #1451: parseMessageReply used to return "" when a completed opencode turn
// contained only non-text parts (a pure tool-call turn). The caller then
// threw "returned no assistant text", reporting a valid outcome to CommHub
// as a failure. The fix synthesizes a marker naming the emitted part types
// so the caller always receives a non-empty reply and the throw was removed.
//
// The part-type universe checked here comes from opencode 1.18.1's own
// OpenAPI /doc schema (probed 2026-08-30 against a real 1.18.1 binary):
// TextPart is one of 13 variants (Tool, Reasoning, File, Patch,
// StepStart, StepFinish, Snapshot, Agent, Retry, Compaction, Subtask,
// FilePartSource[Text]). A completed turn with zero TextPart is a
// canonical shape, not a bug.
describe("OpenCode copresence task deadline", () => {
  async function open(extraEnv: NodeJS.ProcessEnv) {
    const f = fixture(extraEnv);
    const runtime = await openVettedOpenCodeCopresence({
      binary: f.binary,
      env: f.env,
      cwd: f.root,
      workDir: f.root,
      model: "opencode/fake",
      startupTimeoutMs: 5_000,
    });
    return { f, runtime };
  }

  test("honours the configured deadline, says the turn is still running, and never aborts the session", async () => {
    const log = join(tmpdir(), `opencode-deadline-${process.pid}-${Date.now()}.log`);
    const { f, runtime } = await open({ FAKE_TURN_MS: "2500", FAKE_USER_FIRST: "1", FAKE_LOG: log });
    try {
      const started = Date.now();
      let thrown: any;
      try { await runtime.submit("long build", 400); } catch (error) { thrown = error; }
      const elapsed = Date.now() - started;
      expect(thrown).toBeInstanceOf(OpenCodeCopresenceTimeoutError);
      expect(thrown.phase).toBe("reply");
      expect(thrown.timeoutMs).toBe(400);
      // One budget for the task, not per phase, and not the old 300s.
      expect(elapsed).toBeGreaterThanOrEqual(380);
      expect(elapsed).toBeLessThan(2_000);
      // The CommHub reply is the truthful wording, not "opencode 错误: ...aborted".
      const reply = runtimeErrorReplyText("opencode", thrown);
      expect(reply).toBe(thrown.userReplyText);
      expect(reply).toContain("仍在节点的 TUI 会话里运行");
      expect(reply).toContain("没有被中止");
      expect(reply).toContain("OPENCODE_TIMEOUT_MS");
      expect(reply).not.toContain("错误");
      expect(reply).not.toContain("aborted");
      // The bridge only stopped waiting: no abort call, and the turn finishes
      // in the shared session afterwards.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !readFileSync(log, "utf8").includes("TURN_DONE")) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const trace = readFileSync(log, "utf8");
      expect(trace).toContain("TURN_DONE long build");
      expect(trace).not.toMatch(/\/abort/);
    } finally {
      await runtime.close();
      f.close();
      rmSync(log, { force: true });
    }
  }, 20_000);

  test("a POST that timed out without landing in history is reported as not submitted", async () => {
    // Legacy fake order: the user message only appears when the turn ends,
    // so at the deadline the submission is not in history.
    const { f, runtime } = await open({ FAKE_TURN_MS: "2000" });
    try {
      let thrown: any;
      try { await runtime.submit("never landed", 300); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(OpenCodeCopresenceTimeoutError);
      expect(thrown.phase).toBe("admission");
      expect(runtimeErrorReplyText("opencode", thrown)).toContain("opencode 任务未提交");
    } finally {
      await runtime.close();
      f.close();
    }
  }, 20_000);

  test("admission timeout on a busy human session says the task was not submitted", async () => {
    const { f, runtime } = await open({ FAKE_INITIAL_BUSY_MS: "5000" });
    try {
      let thrown: any;
      try { await runtime.submit("queued", 300); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(OpenCodeCopresenceTimeoutError);
      expect(thrown.phase).toBe("admission");
      expect(thrown.message).toContain("remained busy");
      expect(thrown.userReplyText).toContain("本任务没有发出");
      expect(thrown.userReplyText).not.toContain("仍在节点的 TUI 会话里运行");
    } finally {
      await runtime.close();
      f.close();
    }
  }, 20_000);

  test("0 disables the deadline: a turn longer than any fetch budget still returns its reply", async () => {
    const { f, runtime } = await open({ FAKE_TURN_MS: "1200", FAKE_INITIAL_BUSY_MS: "300" });
    try {
      const result = await runtime.submit("no deadline", 0);
      expect(result.replyText).toBe("FAKE_REPLY:no deadline");
    } finally {
      await runtime.close();
      f.close();
    }
  }, 20_000);
});

describe("parseMessageReply (#1451)", () => {
  test("joins and trims text when TextPart present (existing behavior preserved)", () => {
    const msg = { parts: [
      { type: "step-start" },
      { type: "text", text: "hello " },
      { type: "text", text: "world  " },
      { type: "step-finish" },
    ] };
    expect(parseMessageReply(msg)).toBe("hello world");
  });

  test("tool-only turn returns non-empty marker naming the tool part (would have thrown at caller before #1451)", () => {
    const msg = { parts: [
      { type: "step-start" },
      { type: "tool", tool: "bash", state: { output: "ok" } },
      { type: "step-finish" },
    ] };
    const reply = parseMessageReply(msg);
    // The critical assertion — the whole point of the fix: not "" so caller
    // does not throw and CommHub does not see a false failure.
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toContain("tool");
    // step-{start,finish} are book-ends and are deliberately omitted from
    // the marker (they say nothing about what the model did on their own).
    expect(reply).not.toContain("step-start");
    expect(reply).not.toContain("step-finish");
    expect(reply).toContain("no text");
  });

  test("multiple non-text part types are deduped, sorted, and named", () => {
    const msg = { parts: [
      { type: "reasoning", text: "thinking" },
      { type: "tool", tool: "read" },
      { type: "tool", tool: "grep" },
      { type: "patch" },
      { type: "reasoning", text: "more thinking" },
    ] };
    const reply = parseMessageReply(msg);
    // Dedup: "reasoning" and "tool" appear twice each; marker names each once.
    expect(reply).toContain("patch");
    expect(reply).toContain("reasoning");
    expect(reply).toContain("tool");
    // Sorted (alphabetical) — stable output across runs regardless of
    // whatever order opencode happens to emit part types in.
    const patchIdx = reply.indexOf("patch");
    const reasoningIdx = reply.indexOf("reasoning");
    const toolIdx = reply.indexOf("tool");
    expect(patchIdx).toBeLessThan(reasoningIdx);
    expect(reasoningIdx).toBeLessThan(toolIdx);
  });

  test("empty parts array or missing parts still returns non-empty marker (never throws)", () => {
    expect(parseMessageReply({ parts: [] })).toBe("[opencode: assistant returned no reply]");
    expect(parseMessageReply({})).toBe("[opencode: assistant returned no reply]");
    expect(parseMessageReply(null)).toBe("[opencode: assistant returned no reply]");
    expect(parseMessageReply(undefined)).toBe("[opencode: assistant returned no reply]");
  });

  test("text falsiness — a TextPart with empty text falls through to the marker path, not empty return", () => {
    const msg = { parts: [
      { type: "text", text: "   " },  // whitespace-only trims to ""
      { type: "tool", tool: "bash" },
    ] };
    // Whitespace-only text is treated as "no text", so we still get the
    // non-text marker rather than an empty reply.
    const reply = parseMessageReply(msg);
    expect(reply).toContain("tool");
  });
});
