import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { parseNodeGrants, replaceNodeGrants } from "./node-grants.js";

if (!process.env.COMMHUB_DB) throw Error("isolated COMMHUB_DB required");
const stamp = Date.now();
let server: any, base = "", net = "", owner = "", human = "";
const nodes: Record<string, { id: string; token: string }> = {};
const target = () => nodes.target.id;
const put = async (key: string, field: string, body: unknown, id = target()) => {
  const response = await fetch(`${base}/api/nodes/${id}/${field}`, {
    method: "PUT", headers: { Authorization: `Bearer ${key === "human" ? human : nodes[key].token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};
const grant = (kind: "network" | "department" | "node" = "node", scope = target()) =>
  replaceNodeGrants(net, nodes.manager.id, [{ capability: "permissions", scope_kind: kind, scope_id: kind === "network" ? "" : scope, level: "edit" }], owner);
const mode = () => db.get<{ permission_mode: string }>("SELECT permission_mode FROM nodes WHERE node_id = ?1", target())!.permission_mode;
const inbox = () => db.get<{ inbox_allowlist: string | null }>("SELECT inbox_allowlist FROM nodes WHERE node_id = ?1", target())!.inbox_allowlist;

beforeAll(async () => {
  const boss = register(`pg_boss_${stamp}`, "Permissions123!");
  net = boss.network_id!; owner = boss.user!.user_id; human = boss.token!;
  const member = register(`pg_member_${stamp}`, "Permissions123!");
  expect(addNetworkMember(net, member.user!.user_id, "member", owner, { agentAccess: "all" }).ok).toBe(true);
  for (const key of ["manager", "target", "other"]) {
    const id = `n_pg_${key}_${stamp}`;
    const result = createNetworkTokenForNode(member.user!.user_id, net, `pg_${key}_${stamp}`, id);
    expect(result.ok).toBe(true);
    nodes[key] = { id, token: result.token! };
  }
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort, created_by) VALUES (?1, ?2, 'parent', NULL, 0, ?3)", [net, `pg_parent_${stamp}`, owner]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort, created_by) VALUES (?1, ?2, 'child', ?3, 0, ?4)", [net, `pg_child_${stamp}`, `pg_parent_${stamp}`, owner]);
  db.run("UPDATE nodes SET department_id = ?1 WHERE node_id = ?2", [`pg_child_${stamp}`, target()]);
  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);
beforeEach(() => {
  process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
  db.run("UPDATE nodes SET permission_mode = 'normal', inbox_allowlist = NULL WHERE network_id = ?1", net);
  replaceNodeGrants(net, nodes.manager.id, [], owner);
});
afterAll(() => { server?.stop(true); });

test("permissions accepts edit only; existing capabilities still accept read", () => {
  expect(parseNodeGrants(net, [{ capability: "permissions", scope_kind: "network", level: "read" }]).ok).toBe(false);
  expect(parseNodeGrants(net, [{ capability: "permissions", scope_kind: "network", level: "edit" }]).ok).toBe(true);
  expect(parseNodeGrants(net, [{ capability: "rules", scope_kind: "network", level: "read" }]).ok).toBe(true);
});
test("existing grants HTTP endpoint installs permissions and rejects read", async () => {
  const id = nodes.manager.id;
  const denied = await put("human", "grants", { grants: [{ capability: "permissions", scope_kind: "network", level: "read" }] }, id);
  expect(denied.status).toBe(400); expect(denied.body.error).toBe("invalid_level");
  expect((await put("human", "grants", { grants: [{ capability: "permissions", scope_kind: "network", level: "edit" }] }, id)).status).toBe(200);
  expect((await put("manager", "permission-mode", { mode: "readonly" })).status).toBe(200);
});
test("a network-wide grant cannot escape the caller's network", async () => {
  grant("network");
  const outside = register(`pg_outside_${stamp}`, "Permissions123!");
  const id = `n_pg_outside_${stamp}`;
  expect(createNetworkTokenForNode(outside.user!.user_id, outside.network_id!, `pg_outside_${stamp}`, id).ok).toBe(true);
  expect((await put("manager", "permission-mode", { mode: "readonly" }, id)).status).toBe(404);
  expect((await put("manager", "inbox-allowlist", { senders: ["a"] }, id)).status).toBe(404);
});
test("not_granted denies without changing state", async () => {
  const r = await put("manager", "permission-mode", { mode: "readonly" });
  expect(r.status).toBe(403); expect(r.body.reason).toBe("not_granted"); expect(mode()).toBe("normal");
  console.log("DENIAL not_granted", JSON.stringify(r));
});
test("self denies even with a network grant", async () => {
  grant("network");
  const r = await put("manager", "permission-mode", { mode: "readonly" }, nodes.manager.id);
  expect(r.status).toBe(403); expect(r.body.reason).toBe("self");
  console.log("DENIAL self", JSON.stringify(r));
});
test("not_tightening denies a backwards mode transition", async () => {
  grant();
  expect((await put("manager", "permission-mode", { mode: "restricted" })).status).toBe(200);
  const r = await put("manager", "permission-mode", { mode: "normal" });
  expect(r.status).toBe(403); expect(r.body.reason).toBe("not_tightening"); expect(mode()).toBe("restricted");
  console.log("DENIAL not_tightening", JSON.stringify(r));
});
test("forward transitions and exactly one attributed audit per write", async () => {
  grant();
  const count = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ?1 AND action = 'node_permission_mode_changed'", target())!.n);
  const before = count();
  expect((await put("manager", "permission-mode", { mode: "readonly" })).status).toBe(200);
  expect(count()).toBe(before + 1);
  const row = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE target_id = ?1 AND action = 'node_permission_mode_changed' ORDER BY id DESC LIMIT 1", target())!;
  expect(JSON.parse(row.detail).actor_node_id).toBe(nodes.manager.id);
  expect(JSON.parse(row.detail).message).toContain("节点（授权）修改");
});
test("readonly caller cannot use its edit grant", async () => {
  grant(); db.run("UPDATE nodes SET permission_mode = 'readonly' WHERE node_id = ?1", nodes.manager.id);
  const r = await put("manager", "permission-mode", { mode: "readonly" });
  expect(r.status).toBe(403); expect(r.body.reason).toBe("not_granted");
});
test("network grants cover another node, node grants do not", async () => {
  grant(); expect((await put("manager", "permission-mode", { mode: "readonly" }, nodes.other.id)).body.reason).toBe("not_granted");
  grant("network"); expect((await put("manager", "permission-mode", { mode: "readonly" }, nodes.other.id)).status).toBe(200);
});
test("revocation takes effect on the next request", async () => {
  grant(); expect((await put("manager", "permission-mode", { mode: "restricted" })).status).toBe(200);
  replaceNodeGrants(net, nodes.manager.id, [], owner);
  expect((await put("manager", "permission-mode", { mode: "readonly" })).body.reason).toBe("not_granted");
});
test("department grant covers descendants but not nodes outside the subtree", async () => {
  grant("department", `pg_parent_${stamp}`);
  expect((await put("manager", "permission-mode", { mode: "readonly" })).status).toBe(200);
  expect((await put("manager", "permission-mode", { mode: "readonly" }, nodes.other.id)).body.reason).toBe("not_granted");
});
test("inbox delegation also rejects self and missing grants", async () => {
  expect((await put("manager", "inbox-allowlist", { senders: ["a"] })).body.reason).toBe("not_granted");
  grant("network");
  expect((await put("manager", "inbox-allowlist", { senders: ["a"] }, nodes.manager.id)).body.reason).toBe("self");
});
test("removing !strict would restore implicit access and is not tightening", async () => {
  grant(); db.run("UPDATE nodes SET inbox_allowlist = ?1 WHERE node_id = ?2", ['["!strict","a"]', target()]);
  expect((await put("manager", "inbox-allowlist", { senders: ["a"] })).body.reason).toBe("not_tightening");
  expect(inbox()).toBe('["!strict","a"]');
});
test("inbox tightens null to list and list to subset; cannot clear or add", async () => {
  grant();
  const audits = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ?1 AND action = 'node_inbox_allowlist_changed'", target())!.n);
  const before = audits();
  expect((await put("manager", "inbox-allowlist", { senders: ["a", "b"] })).status).toBe(200);
  expect(audits()).toBe(before + 1);
  expect(JSON.parse(db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE target_id = ?1 AND action = 'node_inbox_allowlist_changed' ORDER BY id DESC LIMIT 1", target())!.detail).actor_node_id).toBe(nodes.manager.id);
  expect((await put("manager", "inbox-allowlist", { senders: ["a"] })).status).toBe(200);
  for (const senders of [null, ["a", "b"]]) {
    const r = await put("manager", "inbox-allowlist", { senders });
    expect(r.status).toBe(403); expect(r.body.reason).toBe("not_tightening");
    expect(inbox()).toBe('["a"]');
  }
  expect((await put("manager", "inbox-allowlist", { senders: [] })).status).toBe(400);
});
test("human can loosen after a node, node observes the latest human state", async () => {
  grant(); await put("manager", "permission-mode", { mode: "readonly" });
  expect((await put("human", "permission-mode", { mode: "normal" })).status).toBe(200);
  expect(mode()).toBe("normal");
  expect((await put("manager", "permission-mode", { mode: "restricted" })).status).toBe(200);
  await put("manager", "inbox-allowlist", { senders: ["a"] });
  expect((await put("human", "inbox-allowlist", { senders: null })).status).toBe(200);
  expect(inbox()).toBeNull();
  expect((await put("manager", "inbox-allowlist", { senders: ["b"] })).status).toBe(200);
});
