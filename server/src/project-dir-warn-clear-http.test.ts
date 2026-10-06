// #667 — a restart from the right directory must clear the cwd warning the
// previous process left on the same resume_id. Hub stores
// `task = COALESCE(?11, sessions.task)`, so omitting task keeps the warning.
// The node sends task: "" when idle, nothing is in flight, and there is no
// warning. This boots a throwaway hub on port 0 (never 9200).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportedTask } from "../../agent-node/src/project-dir-mismatch.ts";

const DIR = mkdtempSync(join(tmpdir(), "anet-667-clear-"));
process.env.COMMHUB_DB = join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";

const PW = "ProjectDirWarn123!x";
const stamp = Date.now();
const ROOT = "/work";
const NODE_DIR = "/work/.anet/nodes/demo-node";
const CONFIG = `${NODE_DIR}/config.json`;

let db: { get: (sql: string, ...params: unknown[]) => { task: string | null } | null };
let hub: { port: number; stop: (close?: boolean) => void } | null = null;
let BASE = "";
let NET = "";
let node: { alias: string; nodeId: string; token: string };

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((line) => line.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}

function sessionTask(): string | null {
  return db.get("SELECT task FROM sessions WHERE resume_id = ?1", `sdk-${node.nodeId}`)?.task ?? null;
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { createNetworkTokenForNode, register } = await import("./auth.js");
  const boss = register(`cwd_boss_${stamp}`, PW);
  expect(boss.ok).toBe(true);
  NET = boss.network_id!;
  const alias = `demo-node-${stamp}`;
  const nodeId = `n_cwd_${stamp}`;
  const minted = createNetworkTokenForNode(boss.user!.user_id, NET, alias, nodeId);
  expect(minted.ok).toBe(true);
  node = { alias, nodeId, token: minted.token! };
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  expect(hub.port).not.toBe(9200);
  expect(hub.port).toBeGreaterThan(0);
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop(true); } catch { /* already stopped */ }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
});

describe("#667 restart from the workspace root clears the cwd warning", () => {
  test("wrong directory writes the warning; the right directory sends \"\" and the hub row is empty", async () => {
    const resume = `sdk-${node.nodeId}`;
    const wrong = reportedTask({ configPath: CONFIG, cwd: NODE_DIR, inFlight: 0, status: "idle" });
    expect(wrong).toContain("目录不一致");
    const started = await tool(node.token, "report_status", {
      resume_id: resume, alias: node.alias, status: "idle", node_id: node.nodeId, network_id: NET, task: wrong,
    });
    expect(started.ok).toBe(true);
    expect(sessionTask()).toBe(wrong);

    const kept = await tool(node.token, "report_status", {
      resume_id: resume, alias: node.alias, status: "idle", node_id: node.nodeId, network_id: NET,
    });
    expect(kept.ok).toBe(true);
    expect(sessionTask()).toBe(wrong);

    const cleared = reportedTask({ configPath: CONFIG, cwd: ROOT, inFlight: 0, status: "idle" });
    expect(cleared).toBe("");
    const fixed = await tool(node.token, "report_status", {
      resume_id: resume, alias: node.alias, status: "idle", node_id: node.nodeId, network_id: NET, task: cleared,
    });
    expect(fixed.ok).toBe(true);
    expect(sessionTask()).toBe("");
  });
});
