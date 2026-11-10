// `anet node perm` —— 看 / 改一个节点的权限：模式、对端白名单（它能发给谁）、收件白名单（谁能发给它）。
//
// 只是 Hub 现有 REST 的薄壳：
//   GET /api/nodes?node_id=…                     读 permission_mode / peer_allowlist / inbox_allowlist（+ tool / rest 只读展示）
//   PUT /api/nodes/:id/permission-mode   { mode }
//   PUT /api/nodes/:id/peer-allowlist    { peers }
//   PUT /api/nodes/:id/inbox-allowlist   { senders }
// 写接口要用户令牌（anet login 的那个），节点令牌会被 Hub 回 403 user_token_required。
//
// 🔴 「null = 不限制」与「[] 被拒收」是 Hub 的语义；这里不让 --*-remove 把名单删空——
//    删空就等于把节点完全放开，必须显式写 `none`。

export const NODE_PERM_MODES = ["normal", "readonly", "restricted"] as const;
export type NodePermMode = (typeof NODE_PERM_MODES)[number];

export const NODE_PERM_USAGE = `Usage: anet node perm <node> [--json]
       anet node perm <node> [--mode normal|readonly|restricted]
                             [--peers <a,b,…>|none] [--peers-add <x>] [--peers-remove <x>]
                             [--inbox <a,user:bob,…>|none] [--inbox-add <x>] [--inbox-remove <x>]
                             [--hub <url>] [--json]

Show or change a node's permissions on the Hub.

  --mode            normal | readonly | restricted
  --peers           send-to allowlist: who this node may dispatch to (alias or node_id)
  --inbox           receive-from allowlist: who may send tasks/messages to this node
                      <alias> | <node_id>          an agent
                      user:<username> | user:<id>  a person (Dashboard / app)
                      user:*                       any person
                      !strict                      also require the node's owner and
                                                   network owner/admin to be listed
  none              clears that allowlist (no restriction)
  --*-add/--*-remove  edit one entry; removing the last entry is refused (use none)

<node> is a local node name, a node_id, or a Hub alias. Changes need your user
login (anet login) as the node's owner or a network owner/admin.
Without a change flag it only prints the current settings.

Examples:
  anet node perm reviewer
  anet node perm reviewer --inbox planner,user:alice
  anet node perm reviewer --inbox-add user:bob
  anet node perm reviewer --peers none --mode normal --json`;

type ListEdit = { set: string[] | null } | { add: string[]; remove: string[] };

export type NodePermArgs = {
  ref: string;
  json: boolean;
  hub?: string;
  mode?: NodePermMode;
  peers?: ListEdit;
  inbox?: ListEdit;
};

export type NodePermState = {
  node_id: string;
  alias: string | null;
  network_id: string | null;
  permission_mode: string;
  peer_allowlist: string[] | null;
  /** undefined = this Hub does not know inbox allowlists yet (no node_inbox_allowlist capability). */
  inbox_allowlist: string[] | null | undefined;
  tool_allowlist: string[] | null;
  rest_allowlist: string[] | null;
  can_set_mode: boolean | null;
};

function splitList(v: string): string[] {
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

export function parseNodePermArgs(argv: string[]): { ok: true; args: NodePermArgs } | { ok: false; error: string } {
  let ref = "";
  const out: Omit<NodePermArgs, "ref"> = { json: false };
  const edits: Record<"peers" | "inbox", { set?: string[] | null; add: string[]; remove: string[] }> = {
    peers: { add: [], remove: [] }, inbox: { add: [], remove: [] },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (): string | null => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i++;
      return v;
    };
    if (flag === "--json") { out.json = true; continue; }
    if (flag === "--hub") { const v = value(); if (!v) return { ok: false, error: "--hub needs a URL" }; out.hub = v; continue; }
    if (flag === "--mode") {
      const v = value();
      if (!v || !(NODE_PERM_MODES as readonly string[]).includes(v)) return { ok: false, error: `--mode must be one of ${NODE_PERM_MODES.join(", ")}` };
      out.mode = v as NodePermMode;
      continue;
    }
    const m = /^--(peers|inbox)(?:-(add|remove))?$/.exec(flag);
    if (m) {
      const which = m[1] as "peers" | "inbox";
      const op = m[2] as "add" | "remove" | undefined;
      const v = value();
      if (v === null) return { ok: false, error: `${flag} needs a value${op ? "" : " (a comma list, or none)"}` };
      if (!op) {
        if (v === "none") { edits[which].set = null; continue; }
        const list = splitList(v);
        if (!list.length) return { ok: false, error: `${flag} needs at least one entry; use none to clear` };
        edits[which].set = list;
      } else {
        const list = splitList(v);
        if (!list.length) return { ok: false, error: `${flag} needs an entry` };
        edits[which][op].push(...list);
      }
      continue;
    }
    if (a.startsWith("-")) return { ok: false, error: `unknown option ${a}` };
    if (ref) return { ok: false, error: `unexpected argument ${a}` };
    ref = a;
  }
  if (!ref) return { ok: false, error: "missing <node>" };
  for (const which of ["peers", "inbox"] as const) {
    const e = edits[which];
    const hasDelta = e.add.length > 0 || e.remove.length > 0;
    if (e.set !== undefined && hasDelta) return { ok: false, error: `--${which} cannot be combined with --${which}-add/--${which}-remove` };
    if (e.set !== undefined) out[which] = { set: e.set };
    else if (hasDelta) out[which] = { add: e.add, remove: e.remove };
  }
  return { ok: true, args: { ref, ...out } };
}

export function hasNodePermChange(args: NodePermArgs): boolean {
  return args.mode !== undefined || args.peers !== undefined || args.inbox !== undefined;
}

/** Apply an edit to the current list. Returns the list to PUT (null = clear), or an error. */
export function applyListEdit(current: string[] | null, edit: ListEdit, label: string): { ok: true; next: string[] | null } | { ok: false; error: string } {
  if ("set" in edit) return { ok: true, next: edit.set };
  const next = [...(current ?? [])];
  for (const x of edit.add) if (!next.includes(x)) next.push(x);
  const removed = next.filter(x => !edit.remove.includes(x));
  if (removed.length === 0) {
    return { ok: false, error: `removing the last ${label} entry would clear the allowlist (no restriction); pass --${label} none to do that explicitly` };
  }
  return { ok: true, next: removed };
}

const asList = (v: unknown): string[] | null => (Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === "string") : null);

export function stateFromNodeRow(row: Record<string, any>): NodePermState {
  return {
    node_id: String(row.node_id),
    alias: typeof row.alias === "string" ? row.alias : null,
    network_id: typeof row.network_id === "string" ? row.network_id : null,
    permission_mode: typeof row.permission_mode === "string" ? row.permission_mode : "normal",
    peer_allowlist: asList(row.peer_allowlist),
    inbox_allowlist: "inbox_allowlist" in row ? asList(row.inbox_allowlist) : undefined,
    tool_allowlist: asList(row.tool_allowlist),
    rest_allowlist: asList(row.rest_allowlist),
    can_set_mode: typeof row.viewer_can?.permission_mode === "boolean" ? row.viewer_can.permission_mode : null,
  };
}

export function formatNodePerm(s: NodePermState): string[] {
  const list = (v: string[] | null) => (v ? v.join(", ") : "(any — not restricted)");
  return [
    `${s.alias ?? s.node_id}  (${s.node_id})`,
    `  mode:     ${s.permission_mode}`,
    `  peers:    ${list(s.peer_allowlist)}    — who this node may send to`,
    `  inbox:    ${s.inbox_allowlist === undefined ? "(this Hub does not support inbox allowlists — upgrade the Hub)" : list(s.inbox_allowlist)}    — who may send to this node`,
    ...(s.tool_allowlist ? [`  tools:    ${s.tool_allowlist.join(", ")}`] : []),
    ...(s.rest_allowlist ? [`  rest:     ${s.rest_allowlist.join(", ")}`] : []),
    ...(s.can_set_mode === false ? ["  (you can view but not change this node's permissions)"] : []),
  ];
}

type HubCtx = { hub: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number };

async function hubJson(ctx: HubCtx, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const doFetch = ctx.fetchImpl ?? fetch;
  const res = await doFetch(`${ctx.hub.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

export function describeHubFailure(status: number, body: any, what: string): string {
  const err = typeof body?.error === "string" ? body.error : "";
  const msg = typeof body?.message === "string" ? body.message : "";
  if (status === 401) return `the Hub rejected the login (HTTP 401) — run: anet login`;
  if (err === "user_token_required") return `${what}: the Hub needs your user login, not a node token — run: anet login`;
  if (status === 403) return `${what}: refused (HTTP 403${err ? ` ${err}` : ""}) — only the node's owner or a network owner/admin can change it`;
  if (status === 404 && !err) return `${what}: this Hub does not have that endpoint (HTTP 404) — upgrade the Hub`;
  return `${what}: HTTP ${status}${err ? ` ${err}` : ""}${msg ? ` — ${msg}` : ""}`;
}

/** Find the node on the Hub: exact node_id first, then alias (must be unique across the networks you can see). */
export async function findHubNode(ctx: HubCtx, ref: string, localNodeId?: string): Promise<{ ok: true; row: Record<string, any> } | { ok: false; error: string }> {
  for (const id of [localNodeId, ref].filter((x): x is string => !!x)) {
    const r = await hubJson(ctx, "GET", `/api/nodes?node_id=${encodeURIComponent(id)}`);
    if (r.status !== 200 || !Array.isArray(r.body?.nodes)) return { ok: false, error: describeHubFailure(r.status, r.body, "read node") };
    const hit = r.body.nodes.find((n: any) => n?.node_id === id);
    if (hit) return { ok: true, row: hit };
  }
  const r = await hubJson(ctx, "GET", `/api/nodes?alias=${encodeURIComponent(ref)}`);
  if (r.status !== 200 || !Array.isArray(r.body?.nodes)) return { ok: false, error: describeHubFailure(r.status, r.body, "read node") };
  const hits = r.body.nodes.filter((n: any) => n?.alias === ref);
  if (hits.length === 1) return { ok: true, row: hits[0] };
  if (hits.length > 1) {
    return { ok: false, error: `"${ref}" matches ${hits.length} nodes on the Hub (${hits.map((n: any) => n.node_id).join(", ")}); pass the node_id` };
  }
  return { ok: false, error: `no node "${ref}" on the Hub (or you cannot see it)` };
}

export type NodePermResult =
  | { ok: true; state: NodePermState; changed: string[] }
  | { ok: false; error: string; state?: NodePermState; changed?: string[] };

export async function runNodePerm(ctx: HubCtx, args: NodePermArgs, localNodeId?: string): Promise<NodePermResult> {
  const found = await findHubNode(ctx, args.ref, localNodeId);
  if (!found.ok) return found;
  let state = stateFromNodeRow(found.row);
  const id = encodeURIComponent(state.node_id);
  const changed: string[] = [];
  const fail = (error: string): NodePermResult => ({ ok: false, error, state, changed });

  if (args.inbox && state.inbox_allowlist === undefined) {
    return fail("this Hub does not support inbox allowlists (no inbox_allowlist on GET /api/nodes) — upgrade the Hub");
  }
  if (args.mode !== undefined && args.mode !== state.permission_mode) {
    const r = await hubJson(ctx, "PUT", `/api/nodes/${id}/permission-mode`, { mode: args.mode });
    if (r.status !== 200) return fail(describeHubFailure(r.status, r.body, "set mode"));
    changed.push("mode");
  }
  for (const [which, path, key, label] of [
    ["peers", "peer-allowlist", "peers", "peers"],
    ["inbox", "inbox-allowlist", "senders", "inbox"],
  ] as const) {
    const edit = args[which];
    if (!edit) continue;
    const current = which === "peers" ? state.peer_allowlist : (state.inbox_allowlist ?? null);
    const next = applyListEdit(current, edit, label);
    if (!next.ok) return fail(next.error);
    const r = await hubJson(ctx, "PUT", `/api/nodes/${id}/${path}`, { [key]: next.next });
    if (r.status !== 200) return fail(describeHubFailure(r.status, r.body, `set ${label}`));
    changed.push(label);
  }
  if (changed.length) {
    const reread = await findHubNode(ctx, state.node_id, state.node_id);
    if (reread.ok) state = stateFromNodeRow(reread.row);
  }
  return { ok: true, state, changed };
}
