// Replays the REST/MCP calls the desktop app makes (endpoint list extracted from
// the tested tags' src/) against one Hub and prints {step: {status, shape}}.
// Shapes are type signatures (keys + types, arrays by their first element), so
// ids and timestamps do not create diffs.
const base = process.argv[2];
const out: Record<string, { status: number; shape: unknown }> = {};

// Union of element shapes: each key maps to the sorted set of types seen, so
// element order (e.g. which session is listed first) cannot create a diff.
function mergeShapes(shapes: unknown[]): unknown {
  if (!shapes.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    return [...new Set(shapes.map((x) => JSON.stringify(x)))].sort().join("|");
  }
  const keys = [...new Set(shapes.flatMap((x) => Object.keys(x as object)))].sort();
  const o: Record<string, unknown> = {};
  for (const k of keys) {
    const vals = shapes.map((x) => (x as any)[k] ?? "<absent>");
    const uniq = [...new Set(vals.map((x) => JSON.stringify(x)))].sort();
    o[k] = uniq.length === 1 ? vals[0] : uniq.join("|");
  }
  return o;
}

function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [mergeShapes(v.map(shape))] : ["<empty>"];
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = shape((v as any)[k]);
    return o;
  }
  return typeof v;
}

async function call(step: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), "MCP-Protocol-Version": "2025-03-26" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  const sse = text.split("\n").find((l) => l.startsWith("data: "));
  try { parsed = JSON.parse(sse ? sse.slice(6) : text); } catch { parsed = "<non-json>"; }
  out[step] = { status: res.status, shape: shape(parsed) };
  return parsed as any;
}

async function sse(step: string, path: string, token: string) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const first = await Promise.race([reader.read(), Bun.sleep(1500).then(() => ({ value: undefined }))]);
  ctl.abort();
  const line = new TextDecoder().decode((first as any).value ?? new Uint8Array()).split("\n").find((l) => l.startsWith("data: "));
  let parsed: unknown = "<none>";
  try { parsed = line ? JSON.parse(line.slice(6)) : "<none>"; } catch {}
  out[step] = { status: res.status, shape: shape(parsed) };
}

const mcp = (step: string, token: string, name: string, args: Record<string, unknown>) =>
  call(step, "POST", "/mcp", token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

await call("health", "GET", "/health");
const reg = await call("register.admin", "POST", "/api/auth/register", undefined, { username: "admin", password: "StrongPassw0rd" });
await call("register.member", "POST", "/api/auth/register", undefined, { username: "member", password: "StrongPassw0rd2" });
const login = await call("login", "POST", "/api/auth/login", undefined, { username: "admin", password: "StrongPassw0rd" });
const t = login.token as string;
await call("auth.me", "GET", "/api/auth/me", t);
await call("auth.sessions", "GET", "/api/auth/sessions", t);
await call("admin.users", "GET", "/api/admin/users", t);
const net = await call("networks.create", "POST", "/api/networks", t, { name: "compat-net" });
const nid = net.network_id as string;
await call("networks.list", "GET", "/api/networks", t);
await call("networks.get", "GET", `/api/networks/${nid}`, t);
const nt = await call("node-token", "POST", "/api/auth/node-token", t, { network_id: nid, node_name: "compat-agent" });
const n = nt.token as string;
await mcp("mcp.report_status", n, "report_status", { resume_id: "00000000-0000-4000-8000-00000000c0de", alias: "compat-agent", status: "idle", network_id: nid, node_id: "node-compat-agent" });
await call("status", "GET", `/api/status?network_id=${nid}`, t);
await call("nodes", "GET", `/api/nodes?network_id=${nid}`, t);
const task = await call("task.send", "POST", "/api/task", t, { alias: "compat-agent", task: "compat-ping", priority: "normal", network_id: nid });
await call("tasks.list", "GET", `/api/tasks?network_id=${nid}`, t);
await mcp("mcp.send_reply", n, "send_reply", { in_reply_to: task.task_id, text: "compat-pong", status: "replied" });
// #2176: a scheduled-task reply must count as unread for the schedule's creator.
{
  const nodes = await call("nodes.for_schedule", "GET", `/api/nodes?network_id=${nid}`, t);
  const node = (nodes?.nodes ?? []).find((x: any) => x.alias === "compat-agent" || x.node_name === "compat-agent");
  const sched = await call("sched.create", "POST", "/api/scheduled-tasks", t, {
    network_id: nid, name: "compat schedule", target_node_id: node?.node_id ?? "node-compat-agent", task: "compat scheduled ping", timezone: "UTC", schedule: { type: "interval", every_seconds: 3600 },
  });
  // Clear what the direct task's reply already put there, so only the scheduled reply is counted.
  await fetch(`${base}/api/messages/ack`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "compat-agent" }) });
  const before = await fetch(`${base}/api/messages?scope=user&limit=50`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json(), () => ({}));
  const beforeCount = Number((before as any)?.unread_by_agent?.["compat-agent"] ?? 0);
  const run = await call("sched.run_now", "POST", `/api/scheduled-tasks/${sched?.schedule?.schedule_id}/run-now`, t);
  await mcp("sched.reply", n, "send_reply", { in_reply_to: run?.taskId ?? run?.task_id, text: "compat scheduled pong", status: "replied" });
  const msgs = await fetch(`${base}/api/messages?scope=user&limit=50`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json(), () => ({}));
  const count = Number((msgs as any)?.unread_by_agent?.["compat-agent"] ?? 0) - beforeCount;
  out["sched.unread_for_creator"] = { status: count, shape: count > 0 ? "counted" : "not-counted" };
}
await call("tasks.after_reply", "GET", `/api/tasks?network_id=${nid}`, t);
await call("task_events", "GET", `/api/task_events?network_id=${nid}`, t);
await call("hub.task-events", "GET", `/api/hub/task-events?network_id=${nid}`, t);
await call("messages", "GET", `/api/messages?network_id=${nid}&since=2000-01-01`, t);
const reqm = await call("requirements.create", "POST", "/api/requirements", t, { name: "compat requirement", priority: "normal", network_id: nid, client_id: "compat-client-1" });
await call("requirements.list", "GET", `/api/requirements?network_id=${nid}`, t);
await call("requirements.get", "GET", `/api/requirements/${reqm?.requirement?.id ?? reqm?.requirement?.requirement_id ?? "x"}?network_id=${nid}`, t);
// app 0.2.161: server-side search (q + limit, optionally archived)
await call("requirements.search", "GET", `/api/requirements?network_id=${nid}&q=${encodeURIComponent("compat")}&limit=500`, t);
await call("requirements.search_archived", "GET", `/api/requirements?network_id=${nid}&q=${encodeURIComponent("compat")}&limit=500&archived=true`, t);
// app 0.2.165: task dashboard
await call("requirements.stats", "GET", `/api/requirements/stats?network_id=${nid}&tz=${encodeURIComponent("Asia/Shanghai")}&days=14&recent=20`, t);
// .75 (#2180) new list params and route stats; compared by explicit checks, not by superset.
const since = new Date(Date.now() - 3600_000).toISOString();
await call("newparam.list_summary", "GET", `/api/requirements?network_id=${nid}&view=summary`, t);
await call("newparam.list_changes", "GET", `/api/requirements?network_id=${nid}&changes=1&updated_since=${encodeURIComponent(since)}`, t);
await call("newparam.stats_routes", "GET", `/api/stats/routes?minutes=5`, t);
await call("requirements.people", "GET", `/api/requirements/people?network_id=${nid}`, t);
await call("requirements.projects", "GET", `/api/requirements/projects?network_id=${nid}`, t);
await call("requirements.probe", "PATCH", `/api/requirements/__capability_probe__?network_id=${nid}`, t, { agent_owner: null });
await call("scheduled-tasks.list", "GET", `/api/scheduled-tasks?network_id=${nid}`, t);
await call("side-threads.capability", "GET", `/api/side-threads/capability?alias=compat-agent&networkId=${nid}`, t);
await call("side-threads.list", "GET", `/api/side-threads?alias=compat-agent&networkId=${nid}`, t);
// #2165: /humans with a user token (superset expected: online, last_seen_at)
// and with a node token (must stay identical), plus member_presence on the
// user stream while a second member connects and disconnects.
const member = await call("login.member", "POST", "/api/auth/login", undefined, { username: "member", password: "StrongPassw0rd2" });
await call("members.add", "POST", `/api/networks/${nid}/members`, t, { user_id: member.user.user_id, role: "member" });
await call("humans.user", "GET", `/api/networks/${nid}/humans`, t);
await call("humans.node", "GET", `/api/networks/${nid}/humans`, n);
{
  const seen: any[] = [];
  const ctl = new AbortController();
  const res = await fetch(`${base}/events/users/me?network_id=${nid}`, { headers: { Authorization: `Bearer ${t}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const pump = (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) { try { seen.push(JSON.parse(line.slice(6))); } catch {} }
        }
      }
    } catch {}
  })();
  await Bun.sleep(500);
  const mctl = new AbortController();
  const mres = await fetch(`${base}/events/users/me?network_id=${nid}`, { headers: { Authorization: `Bearer ${member.token}` }, signal: mctl.signal });
  await Bun.sleep(800);
  mctl.abort();
  await Bun.sleep(1200);
  ctl.abort();
  await pump;
  const presence = seen.filter((e) => e?.type === "member_presence");
  out["events.user_stream_types"] = { status: mres.status, shape: [...new Set(seen.map((e) => e?.type))].sort() };
  out["events.member_presence"] = { status: presence.length, shape: presence.length ? shape(presence[0]) : "<none>" };
  await Bun.write(process.env.PRESENCE_OUT ?? "/tmp/presence.json", JSON.stringify(presence));
}
// .74-era calls (app 0.2.164): tag catalog + ops, task-grants, DM-purpose upload.
await call("requirements.tags", "GET", `/api/requirements/tags?network_id=${nid}`, t);
await call("requirements.tags_ops", "POST", `/api/requirements/tags/ops?network_id=${nid}`, t, { op: "color", tag: "compat", color: "#3b82f6" });
await call("task-grants.get", "GET", `/api/networks/${nid}/members/${member.user.user_id}/task-grants`, t);
await call("task-grants.put", "PUT", `/api/networks/${nid}/members/${member.user.user_id}/task-grants`, t, { task_access: "all", project_grants: [] });
{
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "x.png");
  const res = await fetch(`${base}/api/upload?network_id=${nid}&purpose=dm`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: fd });
  let j: unknown = "<non-json>"; try { j = await res.json(); } catch {}
  out["upload.purpose_dm"] = { status: res.status, shape: shape(j) };
}
await call("dm.threads", "GET", `/api/dm/threads?network_id=${nid}`, t);
await call("node-create-requests", "GET", `/api/node-create-requests?request_id=ncr_does_not_exist&network_id=${nid}`, t);
await call("files.missing", "GET", "/api/files/f_does_not_exist", t);
await sse("events.users.me", `/events/users/me?network_id=${nid}`, t);
await sse("events.network", `/events/network/${nid}`, t);
// MCP tools the app calls: compare their input schemas.
const tools = await call("mcp.tools_list", "POST", "/mcp", n, { jsonrpc: "2.0", id: 2, method: "tools/list" });
// Keep the raw tools too: compare.ts checks tools/list per tool name (tools-compat.ts),
// because the merged array shape cannot tell an added property from a removed one.
out["mcp.tools_list"] = { status: out["mcp.tools_list"].status, shape: "<per-tool>", tools: (tools?.result?.tools ?? []).map((x: any) => ({ name: x.name, inputSchema: x.inputSchema })) } as any;
const wanted = ["create_node", "stop_node", "restart_node", "delete_node", "update_node_config", "read_node_rules_file", "write_node_rules_file", "get_rules_file_result", "tail_node_logs"];
const schemas: Record<string, unknown> = {};
for (const tool of tools?.result?.tools ?? []) if (wanted.includes(tool.name)) schemas[tool.name] = tool.inputSchema;
for (const w of wanted) out[`mcp.schema.${w}`] = { status: schemas[w] ? 200 : 404, shape: schemas[w] ?? "<missing>" };
console.log(JSON.stringify(out, null, 2));
