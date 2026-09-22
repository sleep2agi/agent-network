import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runGrokAcpTurn, GrokModelMismatchError } from "./runtime";

describe("runGrokAcpTurn runtime evidence", () => {
  test("separates prompt submission from exact prompt-response consumption", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-evidence-"));
    const fake = join(cwd, "fake-grok.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { authMethods: [{ id: "cached_token" }] } });
  } else if (req.method === "authenticate") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  } else if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "grok-evidence-session" } });
  } else if (req.method === "session/prompt") {
    setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } }), 25);
  }
});
`);
    chmodSync(fake, 0o755);
    const evidence: string[] = [];
    try {
      const turn = runGrokAcpTurn({
        cwd,
        binary: fake,
        prompt: "exact grok evidence",
        drainMs: 0,
        onSubmitted: () => evidence.push("submitted"),
        onConsumed: () => evidence.push("consumed"),
      });
      for (let i = 0; i < 100 && evidence.length === 0; i++) await Bun.sleep(2);
      expect(evidence).toEqual(["submitted"]);
      await turn;
      expect(evidence).toEqual(["submitted", "consumed"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// #1958 — the configured model must reach the agent and the agent's readback
// must match; a disagreement fails closed before any prompt is sent.
describe("runGrokAcpTurn model selection (#1958)", () => {
  // Fake grok: records argv + every request method/params to LOG_FILE.
  // Behaviour of session/set_model is driven by MODE:
  //   ok        → {_meta:{model:{Ok:<requested>}}} + model_changed(<requested>)
  //   drift     → Ok:"grok-4.7" + model_changed("grok-4.7") regardless of request
  //   unknown   → JSON-RPC -32602 "unknown model id"
  //   nomethod  → JSON-RPC -32601 method not found
  function writeFake(cwd: string): string {
    const fake = join(cwd, "fake-grok.js");
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
const logFile = process.env.LOG_FILE;
const mode = process.env.MODE || "ok";
const entries = { argv: process.argv.slice(2), calls: [] };
function flush() { fs.writeFileSync(logFile, JSON.stringify(entries)); }
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
flush();
rl.on("line", (line) => {
  const req = JSON.parse(line);
  entries.calls.push({ method: req.method, params: req.params });
  flush();
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { authMethods: [{ id: "cached_token" }] } });
  } else if (req.method === "authenticate") {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  } else if (req.method === "session/new" || req.method === "session/load") {
    send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "grok-model-session", update: { sessionUpdate: "model_changed", model_id: "grok-4.7" } } });
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "grok-model-session", models: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7" }, { modelId: "grok-4.6" }] } } });
  } else if (req.method === "session/set_model") {
    if (mode === "unknown") {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Invalid params", data: "unknown model id" } });
    } else if (mode === "nomethod") {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
    } else {
      const applied = mode === "drift" ? "grok-4.7" : req.params.modelId;
      send({ jsonrpc: "2.0", id: req.id, result: { _meta: { model: { Ok: applied } } } });
      send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "grok-model-session", update: { sessionUpdate: "model_changed", model_id: applied } } });
    }
  } else if (req.method === "session/prompt") {
    setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } }), 10);
  }
});
`);
    chmodSync(fake, 0o755);
    return fake;
  }
  function readLog(file: string): { argv: string[]; calls: Array<{ method: string; params: any }> } {
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const methods = (log: { calls: Array<{ method: string }> }) => log.calls.map((c) => c.method);

  test("configured model goes on argv, is applied with session/set_model, and the readback is reported", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-model-ok-"));
    const logFile = join(cwd, "log.json");
    try {
      const result = await runGrokAcpTurn({
        cwd, binary: writeFake(cwd), prompt: "hi", drainMs: 0, model: "grok-4.6",
        env: { LOG_FILE: logFile, MODE: "ok" },
      });
      const log = readLog(logFile);
      expect(log.argv).toEqual(["agent", "-m", "grok-4.6", "stdio"]);
      const setModel = log.calls.find((c) => c.method === "session/set_model");
      expect(setModel?.params).toEqual({ sessionId: "grok-model-session", modelId: "grok-4.6" });
      expect(methods(log).indexOf("session/set_model")).toBeLessThan(methods(log).indexOf("session/prompt"));
      expect(result.effectiveModel).toBe("grok-4.6");
      expect(result.modelSource).toBe("readback");
      expect(result.state.modelId).toBe("grok-4.6");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("agent applying a different model than configured fails closed before session/prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-model-drift-"));
    const logFile = join(cwd, "log.json");
    try {
      let caught: unknown;
      try {
        await runGrokAcpTurn({ cwd, binary: writeFake(cwd), prompt: "hi", drainMs: 0, model: "grok-4.6", env: { LOG_FILE: logFile, MODE: "drift" } });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GrokModelMismatchError);
      const msg = String((caught as Error).message);
      expect(msg).toContain('"grok-4.6"');
      expect(msg).toContain('"grok-4.7"');
      expect(methods(readLog(logFile))).not.toContain("session/prompt");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("agent rejecting the model id (-32602 unknown model id) surfaces verbatim and never retries without the model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-model-unknown-"));
    const logFile = join(cwd, "log.json");
    try {
      let caught: unknown;
      try {
        await runGrokAcpTurn({ cwd, binary: writeFake(cwd), prompt: "hi", drainMs: 0, model: "grok-nope-9", env: { LOG_FILE: logFile, MODE: "unknown" } });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(GrokModelMismatchError);
      expect(String((caught as Error).message)).toContain("unknown model id");
      expect(String((caught as Error).message)).toContain('"grok-nope-9"');
      const log = readLog(logFile);
      expect(methods(log)).not.toContain("session/prompt");
      expect(log.calls.filter((c) => c.method === "session/set_model")).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a grok build without session/set_model degrades to argv-only and says so", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-model-nomethod-"));
    const logFile = join(cwd, "log.json");
    const stderr: string[] = [];
    try {
      const result = await runGrokAcpTurn({
        cwd, binary: writeFake(cwd), prompt: "hi", drainMs: 0, model: "grok-4.6",
        env: { LOG_FILE: logFile, MODE: "nomethod" }, onStderr: (l) => stderr.push(l),
      });
      expect(result.modelSource).toBe("argv");
      expect(result.effectiveModel).toBe("grok-4.6");
      expect(readLog(logFile).argv).toEqual(["agent", "-m", "grok-4.6", "stdio"]);
      expect(stderr.join("\n")).toContain("no session/set_model");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no configured model: plain argv, no set_model, and the agent's default is reported as such", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-model-default-"));
    const logFile = join(cwd, "log.json");
    try {
      const result = await runGrokAcpTurn({ cwd, binary: writeFake(cwd), prompt: "hi", drainMs: 0, env: { LOG_FILE: logFile, MODE: "ok" } });
      const log = readLog(logFile);
      expect(log.argv).toEqual(["agent", "stdio"]);
      expect(methods(log)).not.toContain("session/set_model");
      expect(result.modelSource).toBe("default");
      expect(result.effectiveModel).toBe("grok-4.7");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
