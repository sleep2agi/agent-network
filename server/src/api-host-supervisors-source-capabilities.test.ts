// #4495 — /api/host-supervisors 投影「源目录 / 新建节点 / 复用已有 Session」这五条能力。
//
// 之前这五条只存在 nodes.config_snapshot 里,没有任何 REST 出口:
// 生产上 daemon-dev / daemon-vdev 明明报了(见 DB),客户端却只能靠猜
// (app 的 NodeSourcePalette 直接写死 hasProjectCreateCapability: true)。
//
// 口径与 can_create_nodes 一致:daemon 没报 ⇒ 键不出现;报的值不认识 ⇒ 也不出现,
// 绝不把任意字符串透给客户端当能力。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import "./require-explicit-test-db.js";
import { register, login } from "./auth.js";
import { db } from "./db.js";

let BASE = "";
let server: any = null;
let userToken = "";
let userNetworkId = "";
let userId = "";

const CAPS = {
  source_directory_read: "source-directory-read-v1-opencode-2.0.22",
  project_new_session: "project-new-session-v1-opencode-2.0.22",
  session_attach: "existing-session-attach-v1-opencode-2.0.22",
  source_fork_transport: "source-fork-transport-v1-opencode-2.0.22",
  source_node_delivery: "source-node-delivery-v1-opencode-2.0.22",
};

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const password = "BootstrapPw123Aa!";
  const seed = register(`shc_seed_${suffix}`, password, undefined, "seed");
  if (!seed.ok) throw new Error("seed failed");
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [`shc_seed_${suffix}`]);
  const u = register(`shc_u_${suffix}`, password, undefined, "seed");
  if (!u.ok || !u.token) throw new Error("user register failed");
  userToken = u.token;
  userNetworkId = u.network_id ?? "";
  userId = login(`shc_u_${suffix}`, password).user!.user_id;
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  await new Promise((r) => setTimeout(r, 100));
}, 60_000);

afterAll(() => { try { server?.stop?.(true); } catch {} });

function seedDaemon(alias: string, snapshot: object | null): void {
  db.run(
    `INSERT OR REPLACE INTO nodes (node_id, node_name, alias, runtime, model, config_path,
       channels, server, hostname, network_id, config_revision, config_snapshot)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [`shc_n_${alias}`, alias, alias, "claude-agent-sdk", "m", "/tmp/c.json", "[]", "h", "h",
     userNetworkId, 0, snapshot === null ? null : JSON.stringify(snapshot)],
  );
  db.run(
    `INSERT OR REPLACE INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [`shc_t_${alias}`, `hash_${alias}`, userId, userNetworkId, `node:${alias}`, "network"],
  );
}
const clearDaemons = () => {
  db.run("DELETE FROM nodes WHERE network_id = ?1", [userNetworkId]);
  db.run("DELETE FROM api_tokens WHERE network_id = ?1 AND name LIKE 'node:%'", [userNetworkId]);
};
async function daemon(alias: string): Promise<any> {
  const res = await fetch(`${BASE}/api/host-supervisors`, { headers: { Authorization: `Bearer ${userToken}` } });
  const body = await res.json();
  if (!body.ok) throw new Error("list failed: " + JSON.stringify(body));
  const d = body.daemons.find((x: any) => x.alias === alias);
  if (!d) throw new Error(`daemon ${alias} missing`);
  return d;
}

describe("#4495 — host_supervisors 投影源能力", () => {
  test("报了五条 ⇒ 原值出现在响应里（客户端终于有得可读）", async () => {
    clearDaemons();
    seedDaemon("caps-a", { role: "host_supervisor", daemon_capabilities: { ...CAPS } });
    const d = await daemon("caps-a");
    for (const [k, v] of Object.entries(CAPS)) expect(d[k]).toBe(v);
  });

  test("值不认识 / 类型不对 ⇒ 键不出现（不透传任意字符串）", async () => {
    clearDaemons();
    seedDaemon("caps-b", {
      role: "host_supervisor",
      daemon_capabilities: {
        source_directory_read: "source-directory-read-v0-something",
        project_new_session: 1,
        session_attach: "",
      },
    });
    const d = await daemon("caps-b");
    expect(d.source_directory_read).toBeUndefined();
    expect(d.project_new_session).toBeUndefined();
    expect(d.session_attach).toBeUndefined();
  });

  test("老 daemon（有 role 但没报这些能力）⇒ 五条都不出现，不是 false/null", async () => {
    clearDaemons();
    // 🔴 没有 snapshot 的节点根本不会被当成 host_supervisor 列出（role 判不出来），
    //    所以「老 daemon」的真实形状是：有 role，但 daemon_capabilities 里没这几条。
    seedDaemon("caps-c", { role: "host_supervisor", daemon_capabilities: { can_create_nodes: true } });
    const d = await daemon("caps-c");
    for (const k of Object.keys(CAPS)) expect(k in d).toBe(false);
  });
});
