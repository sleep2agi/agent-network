// 负责人 / 负责 Agent 拆分:一次性 Hub 进程的升级端到端。
// 真起两次 `bun run src/index.ts`(HOME=临时目录、随机端口、绝不是 9200、独立库):
//   第一次:注册、建节点、建一张「旧式」卡(owner 是节点 —— 用 SQL 写进去,因为新 Hub 已不接受);
//          再把 agent_owner_json 列删掉,库回到 #2065 时代的样子。
//   第二次:同一个库启动 = 升级。启动迁移把节点挪到 agent_owner,HTTP 读回;然后走一遍新规则。
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "anet-req-agent-owner-e2e-"));
const dbFile = join(home, "hub.db");
const port = 20000 + Math.floor(Math.random() * 20000);
if (port === 9200) throw new Error("9200 is the production hub port");
const base = `http://127.0.0.1:${port}`;
const serverDir = resolve(import.meta.dir, "..");
let proc: ChildProcess | null = null;

async function startHub() {
  proc = spawn("bun", ["run", "src/index.ts"], {
    cwd: serverDir,
    env: { PATH: process.env.PATH || "", HOME: home, COMMHUB_DB: dbFile, COMMHUB_SERVER: "1", PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  proc.stderr?.on("data", d => { err += String(d); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`hub did not start on ${port}: ${err.slice(-600)}`);
}
async function stopHub() {
  if (!proc) return;
  const p = proc;
  proc = null;
  await new Promise<void>(res => { p.once("exit", () => res()); p.kill("SIGTERM"); setTimeout(() => { p.kill("SIGKILL"); res(); }, 5000); });
}
afterAll(async () => { await stopHub(); try { rmSync(home, { recursive: true, force: true }); } catch {} });

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  return { status: res.status, body: await res.json() as any };
}

test("an upgraded hub moves node owners to agent_owner and then enforces human owner / agent executor", async () => {
  await startHub();
  const reg = await (await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "e2e_owner", password: "E2eOwner123!pass" }) })).json() as any;
  expect(reg.ok).toBe(true);
  const token = reg.token as string, net = reg.network_id as string, uid = reg.user.user_id as string;
  const human = { kind: "user", id: uid }, agent = { kind: "node", id: "node_e2e_exec" };
  {
    const db = new Database(dbFile);
    db.run("INSERT INTO nodes (node_id,node_name,alias,network_id) VALUES (?1,'e2e-exec','e2e-exec',?2)", [agent.id, net]);
    db.close();
  }
  const card = await api(token, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "旧式卡", network_id: net, participants: [human] }) });
  expect(card.status).toBe(201);
  const keep = await api(token, "/api/requirements", { method: "POST", body: JSON.stringify({ name: "人类负责人卡", network_id: net, owner: human }) });
  expect(keep.status).toBe(201);
  await stopHub();
  {
    // 退回旧库:节点当负责人,且没有 agent_owner_json 列
    const db = new Database(dbFile);
    db.run("UPDATE requirements SET owner_json = ?1 WHERE requirement_id = ?2", [JSON.stringify(agent), card.body.requirement.id]);
    db.exec("ALTER TABLE requirements DROP COLUMN agent_owner_json");
    const cols = (db.query("PRAGMA table_info(requirements)").all() as { name: string }[]).map(c => c.name);
    expect(cols.includes("agent_owner_json")).toBe(false);
    db.close();
  }
  await startHub();
  const listed = await api(token, `/api/requirements?network_id=${net}`);
  expect(listed.status).toBe(200);
  expect(listed.body.requirements.length).toBe(2);
  const upgraded = listed.body.requirements.find((r: any) => r.id === card.body.requirement.id);
  expect(upgraded.owner).toBeNull();
  expect(upgraded.agent_owner).toEqual(agent);
  expect(upgraded.participants).toEqual([human]);
  expect(upgraded.name).toBe("旧式卡");
  const untouched = listed.body.requirements.find((r: any) => r.id === keep.body.requirement.id);
  expect(untouched.owner).toEqual(human);
  expect(untouched.agent_owner).toBeNull();

  const path = `/api/requirements/${upgraded.id}?network_id=${net}`;
  const both = await api(token, path, { method: "PATCH", body: JSON.stringify({ owner: human }) });
  expect(both.status).toBe(200);
  expect(both.body.requirement.owner).toEqual(human);
  expect(both.body.requirement.agent_owner).toEqual(agent);
  expect((await api(token, path, { method: "PATCH", body: JSON.stringify({ owner: agent }) })).body.error).toBe("owner_must_be_human");
  expect((await api(token, path, { method: "PATCH", body: JSON.stringify({ agent_owner: human }) })).body.error).toBe("agent_owner_must_be_agent");

  // 第三次启动(同一个库):迁移不再改任何东西
  await stopHub();
  await startHub();
  const again = (await api(token, `/api/requirements?network_id=${net}`)).body.requirements;
  expect(again.length).toBe(2);
  const same = again.find((r: any) => r.id === upgraded.id);
  expect(same.owner).toEqual(human);
  expect(same.agent_owner).toEqual(agent);
}, 60_000);
