// test562 seed — builds the fixture on the throwaway hub through its real REST + MCP surface.
// argv: <hub url> <admin utok> <admin network_id> <member username> <member password>
// stdout: one JSON line { net, other, otherName, memberId, daemonNtok }
const [hub, adminTok, NET, memberName, memberPw] = process.argv.slice(2);
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function rest(method: string, path: string, tok: string, body?: unknown) {
  const r = await fetch(`${hub}${path}`, { method, headers: H(tok), body: body === undefined ? undefined : JSON.stringify(body) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new Error(`${method} ${path} → HTTP ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function tool(tok: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: { ...H(tok), Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const data = raw.split("\n").filter(l => l.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const out = JSON.parse(payload.result.content[0].text);
  if (out.ok === false || out.error) throw new Error(`${name} → ${raw.slice(0, 400)}`);
  return out;
}

type N = { alias: string; node_id: string; net: string; hostname: string; agent: string; model?: string; status: string; daemon?: boolean };
async function seedNode(n: N): Promise<string> {
  const t = await rest("POST", "/api/auth/node-token", adminTok, { network_id: n.net, node_name: n.alias, node_id: n.node_id });
  const ntok = t.token as string;
  if (!ntok?.startsWith("ntok_")) throw new Error(`node-token for ${n.alias}: ${JSON.stringify(t)}`);
  await tool(ntok, "report_status", {
    resume_id: `resume_${n.node_id}`,
    alias: n.alias,
    status: n.status,
    hostname: n.hostname,
    agent: n.agent,
    ...(n.model ? { model: n.model } : {}),
    node_id: n.node_id,
    network_id: n.net,
    ...(n.daemon ? { config_snapshot: { role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["claude-agent-sdk"] } } } : {}),
  });
  return ntok;
}

const other = (await rest("POST", "/api/networks", adminTok, { name: "t562-other" }));
const OTHER = other.network?.network_id ?? other.network_id;
if (!OTHER) throw new Error(`no other network id: ${JSON.stringify(other)}`);

const daemonNtok = await seedNode({ alias: "alpha-daemon", node_id: "n_t562_daemon", net: NET, hostname: "host-alpha", agent: "claude-agent-sdk", status: "idle", daemon: true });
await seedNode({ alias: "a-coder", node_id: "n_t562_acoder", net: NET, hostname: "host-alpha", agent: "claude-agent-sdk", model: "model-coder-1", status: "idle" });
await seedNode({ alias: "a-writer", node_id: "n_t562_awriter", net: NET, hostname: "host-alpha", agent: "codex-app-server", model: "model-writer-2", status: "working" });
await seedNode({ alias: "b-runner", node_id: "n_t562_brunner", net: NET, hostname: "host-beta", agent: "grok-build-cli", status: "offline" });
await seedNode({ alias: "x-other", node_id: "n_t562_xother", net: OTHER, hostname: "host-gamma", agent: "claude-agent-sdk", status: "idle" });

// A member of NET whose agent access is restricted to a-coder only.
const created = await rest("POST", "/api/admin/users", adminTok, { username: memberName, password: memberPw, network_id: NET, role: "member" });
const memberId = created.user?.user_id;
if (!memberId) throw new Error(`member create: ${JSON.stringify(created)}`);
const g = await rest("PUT", `/api/networks/${NET}/members/${memberId}/agent-grants`, adminTok, { grants: ["n_t562_acoder"] });
if (g.restricted !== true) throw new Error(`member is not restricted: ${JSON.stringify(g)}`);

console.log(JSON.stringify({ net: NET, other: OTHER, otherName: "t562-other", memberId, daemonNtok }));
