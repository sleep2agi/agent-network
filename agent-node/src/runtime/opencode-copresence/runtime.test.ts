import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import {
  linuxProcessGroupIsGone,
  readLinuxProcessGroupIdentity,
  sameLinuxProcessGroupIdentity,
  signalExactLinuxProcessGroup,
} from "./process-group";
import {
  OPENCODE_COMMHUB_TOKEN_ENV,
  openVettedOpenCodeCopresence,
  requireOpenCodeCopresenceModel,
  wireOpenCodeCommhubMcp,
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
  const server = http.createServer(async (req, res) => {
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
      if (json.title !== "Agent Network message" || json.variant !== "info" || json.duration !== 15000) {
        res.writeHead(400); return res.end("invalid notification toast");
      }
      if (!(json.message || "").startsWith("notice:")) {
        res.writeHead(400); return res.end("missing notification message");
      }
      return send(res, true);
    }
    const match = req.url.match(/^\\/session\\/(ses_[A-Za-z0-9]+)\\/message$/);
    if (match && req.method === "POST") {
      const id = match[1];
      if ((json.parts?.[0]?.text || "").startsWith("notice:") || json.noReply === true) {
        res.writeHead(400); return res.end("notifications must not enter session history");
      }
      if (env.FAKE_REQUIRE_MODEL === "1" && (json.model?.providerID !== "opencode" || json.model?.modelID !== "fake")) {
        res.writeHead(400); return res.end("missing model identity");
      }
      statuses[id] = { type:"busy" };
      await new Promise(r => setTimeout(r, Number(env.FAKE_TURN_MS || 25)));
      const prompt = json.parts?.[0]?.text || "";
      const reply = "FAKE_REPLY:" + prompt;
      messages[id].push({ info:{role:"assistant"}, parts:[{type:"text",text:reply}] });
      delete statuses[id];
      return send(res, { parts:[{type:"text",text:reply}] });
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

      await runtime.notify("notice:dashboard-message", 5_000);

      const [one, two] = await Promise.all([
        runtime.submit("one", 5_000),
        runtime.submit("two", 5_000),
      ]);
      expect(one.replyText).toBe("FAKE_REPLY:one");
      expect(two.replyText).toBe("FAKE_REPLY:two");
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

  test("waits for an already-busy human session before injecting a network turn", async () => {
    const f = fixture({ FAKE_INITIAL_BUSY_MS: "350" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
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

  test("does not treat a missing session status and missing session record as idle", async () => {
    const f = fixture({ FAKE_SESSION_LOOKUP_MISSING: "1" });
    let runtime: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
    try {
      runtime = await openVettedOpenCodeCopresence({
        binary: f.binary,
        env: f.env,
        cwd: f.root,
        workDir: f.root,
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
