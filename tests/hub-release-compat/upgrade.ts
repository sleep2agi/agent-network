// Upgrade-in-place probe: `seed` writes data through the Hub's HTTP API (as an
// old app would), `view` prints what the pre-existing member sees. The run
// script calls seed on the old Hub, then view on old → new → old (rollback) → new.
const [mode, base, stateFile] = process.argv.slice(2);
const PW = { admin: "StrongPassw0rd", member: "StrongPassw0rd2" };

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
const login = async (u: "admin" | "member") => (await api("POST", "/api/auth/login", undefined, { username: u, password: PW[u] })).body;

if (mode === "seed") {
  await api("POST", "/api/auth/register", undefined, { username: "admin", password: PW.admin });
  await api("POST", "/api/auth/register", undefined, { username: "member", password: PW.member });
  const a = await login("admin"), m = await login("member");
  const net = (await api("POST", "/api/networks", a.token, { name: "upgrade-net" })).body;
  const add = await api("POST", `/api/networks/${net.network_id}/members`, a.token, { user_id: m.user.user_id, role: "member" });
  const cards: string[] = [];
  for (const [i, column] of ["todo", "doing", "done"].entries()) {
    const r = await api("POST", "/api/requirements", a.token, { name: `upgrade card ${i}`, priority: "normal", network_id: net.network_id, client_id: `upgrade-${i}` });
    const id = r.body?.requirement?.id ?? r.body?.requirement?.requirement_id;
    await api("PATCH", `/api/requirements/${id}?network_id=${net.network_id}`, a.token, { column, tags: ["compat", `c${i}`] });
    cards.push(id);
  }
  await Bun.write(stateFile, JSON.stringify({ network_id: net.network_id, member_add_status: add.status, cards }));
  console.log(JSON.stringify({ seeded: cards.length, member_add_status: add.status }));
} else if (mode === "view") {
  const state = JSON.parse(await Bun.file(stateFile).text());
  const m = await login("member");
  const nid = state.network_id;
  const list = await api("GET", `/api/requirements?network_id=${nid}`, m.token);
  const cards: Record<string, unknown> = {};
  for (const id of state.cards) cards[id] = (await api("GET", `/api/requirements/${id}?network_id=${nid}`, m.token)).body?.requirement ?? null;
  // Raw bytes of the full list with no new params, as an existing app fetches it.
  const { createHash } = await import("node:crypto");
  const raw = async (tok: string) => {
    const res = await fetch(`${base}/api/requirements?network_id=${nid}`, { headers: { Authorization: `Bearer ${tok}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    const j = JSON.parse(buf.toString("utf8"));
    return { sha: createHash("sha256").update(buf).digest("hex"), nocaps: createHash("sha256").update(JSON.stringify({ ...j, capabilities: null })).digest("hex"), caps: j.capabilities as string[] };
  };
  const rm = await raw(m.token), ra = await raw((await login("admin")).token);
  const prevCaps: string[] | null = process.env.PREV_CAPS_FILE && require("fs").existsSync(process.env.PREV_CAPS_FILE) ? JSON.parse(require("fs").readFileSync(process.env.PREV_CAPS_FILE, "utf8")) : null;
  if (process.env.PREV_CAPS_FILE && !prevCaps) require("fs").writeFileSync(process.env.PREV_CAPS_FILE, JSON.stringify(rm.caps));
  const capsAdded = prevCaps ? rm.caps.filter((x) => !prevCaps.includes(x)) : [];
  const capsAddedOk = prevCaps ? JSON.stringify(rm.caps.slice(0, prevCaps.length)) === JSON.stringify(prevCaps) : true;
  const listShaMember = rm.sha, listShaAdmin = ra.sha;
  const me = await api("GET", "/api/auth/me", m.token);
  // task-grants is an admin view; read the member's mode as the admin sees it.
  const adm = await login("admin");
  const grants = await api("GET", `/api/networks/${nid}/members/${m.user.user_id}/task-grants`, adm.token);
  console.log(JSON.stringify({
    health: (await api("GET", "/health")).status,
    list_status: list.status,
    visible_ids: (list.body?.requirements ?? []).map((r: any) => r.id ?? r.requirement_id).sort(),
    cards,
    me_task_access: me.body?.task_access ?? me.body?.user?.task_access ?? null,
    grants_status: grants.status,
    grants_task_access: grants.body?.task_access ?? null,
    list_sha_member: listShaMember,
    list_sha_admin: listShaAdmin,
    list_nocaps_member: rm.nocaps,
    list_nocaps_admin: ra.nocaps,
    caps_added: capsAdded,
    caps_added_ok: capsAddedOk,
  }));
} else if (mode === "new-member") {
  // A member added AFTER the upgrade through the old-app request shape (no task_access field).
  const state = JSON.parse(await Bun.file(stateFile).text());
  const a = await login("admin");
  await api("POST", "/api/auth/register", undefined, { username: "late", password: "StrongPassw0rd3" });
  const late = (await api("POST", "/api/auth/login", undefined, { username: "late", password: "StrongPassw0rd3" })).body;
  const add = await api("POST", `/api/networks/${state.network_id}/members`, a.token, { user_id: late.user.user_id, role: "member" });
  const list = await api("GET", `/api/requirements?network_id=${state.network_id}`, late.token);
  const grants = await api("GET", `/api/networks/${state.network_id}/members/${late.user.user_id}/task-grants`, a.token);
  console.log(JSON.stringify({ add_status: add.status, visible: (list.body?.requirements ?? []).length, of: state.cards.length, task_access: grants.body?.task_access ?? null }));
}
