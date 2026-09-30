// L3–L5 of the PostgreSQL ladder (L0–L2 are checked by run.sh).
// Prints one PASS/FAIL line per level and exits with the highest level reached
// as `LADDER_LEVEL=<n>` on stdout. Never throws past main(): a thrown error is
// a FAIL at the level being attempted, not a crash of the harness.
const base = process.argv[2];
if (!base) { console.error("usage: ladder.ts <hub base url>"); process.exit(2); }

let level = 2;
function pass(n: number, what: string) { level = n; console.log(`PASS L${n} ${what}`); }
function fail(n: number, what: string): never {
  console.log(`FAIL L${n} ${what}`);
  console.log(`LADDER_LEVEL=${level}`);
  process.exit(0);
}

async function json(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers as any) } });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: { raw: text } }; }
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(base + "/mcp", {
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
  const line = raw.split("\n").find(l => l.startsWith("data: "));
  const env = JSON.parse(line ? line.slice(6) : raw);
  const text: string = env?.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { ok: false, error: text || raw.slice(0, 300) }; }
}

async function main() {
  // L3 — first registered user is the hub admin. On a migrated database
  // (LADDER_EXISTING_ADMIN=1) that admin already exists: log in as it instead.
  if (process.env.LADDER_EXISTING_ADMIN === "1") {
    const again = await json("/api/auth/login", {
      method: "POST", body: JSON.stringify({ username: "admin", password: "StrongPassw0rd" }),
    });
    if (again.status !== 200 || again.body?.user?.role !== "admin") fail(3, `existing admin login: ${again.status} ${JSON.stringify(again.body).slice(0, 300)}`);
    pass(3, "the migrated admin logs in with its original password and is still admin");
  } else {
    const reg = await json("/api/auth/register", {
      method: "POST", body: JSON.stringify({ username: "admin", password: "StrongPassw0rd" }),
    });
    if (reg.status !== 200 || reg.body?.ok !== true) fail(3, `register: ${reg.status} ${JSON.stringify(reg.body).slice(0, 300)}`);
    if (reg.body.user?.role !== "admin") fail(3, `first user role is ${JSON.stringify(reg.body.user?.role)}, expected "admin"`);
    pass(3, "first registered user is admin");
  }

  // L4 — login → network → node token → report_status → POST /api/task.
  const login = await json("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username: "admin", password: "StrongPassw0rd" }),
  });
  const utok: string = login.body?.token ?? "";
  if (!utok.startsWith("utok_")) fail(4, `login: ${login.status} ${JSON.stringify(login.body).slice(0, 300)}`);
  const net = await json("/api/networks", { method: "POST", token: utok, body: JSON.stringify({ name: process.env.LADDER_NET_NAME || "pg-ladder" }) });
  const networkId: string = net.body?.network_id ?? net.body?.network?.network_id ?? "";
  if (!networkId) fail(4, `create network: ${net.status} ${JSON.stringify(net.body).slice(0, 300)}`);
  const nt = await json("/api/auth/node-token", {
    method: "POST", token: utok, body: JSON.stringify({ network_id: networkId, node_name: "pg-agent" }),
  });
  const ntok: string = nt.body?.token ?? "";
  if (!ntok.startsWith("ntok_")) fail(4, `node token: ${nt.status} ${JSON.stringify(nt.body).slice(0, 300)}`);
  const rs = await mcp(ntok, "report_status", {
    resume_id: "00000000-0000-4000-8000-000000002123", alias: "pg-agent", status: "idle", network_id: networkId,
  });
  if (rs.ok !== true) fail(4, `report_status: ${JSON.stringify(rs).slice(0, 300)}`);
  const task = await json("/api/task", {
    method: "POST", token: utok,
    body: JSON.stringify({ alias: "pg-agent", task: "ladder-ping", priority: "normal", network_id: networkId }),
  });
  const taskId: string = task.body?.task_id ?? "";
  if (task.body?.ok !== true || !taskId) fail(4, `send task: ${task.status} ${JSON.stringify(task.body).slice(0, 300)}`);
  pass(4, "login, node token, report_status, POST /api/task");

  // L5 — the node replies; the tool says ok AND the task row is terminal.
  const rep = await mcp(ntok, "send_reply", { in_reply_to: taskId, text: "ladder-pong", status: "replied" });
  if (rep.ok !== true) {
    // With real transactions a failed reply must leave no half-written row.
    const after = await json(`/api/tasks?to_name=pg-agent&network_id=${encodeURIComponent(networkId)}`, { token: utok });
    const r = (after.body?.tasks ?? []).find((t: any) => t.task_id === taskId);
    console.log(`INFO task row after the failed reply: status=${r?.status} result=${JSON.stringify(r?.result ?? null)}`);
    fail(5, `send_reply: ${JSON.stringify(rep).slice(0, 300)}`);
  }
  const list = await json(`/api/tasks?to_name=pg-agent&network_id=${encodeURIComponent(networkId)}`, { token: utok });
  const row = (list.body?.tasks ?? []).find((t: any) => t.task_id === taskId);
  if (row?.status !== "replied" || row?.result !== "ladder-pong") fail(5, `task row after reply: ${JSON.stringify(row).slice(0, 300)}`);
  pass(5, "send_reply ok and task row replied");

  console.log(`LADDER_LEVEL=${level}`);
}

main().catch(e => fail(level + 1, `threw: ${e?.message ?? e}`));
