import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdentityFromConfig } from "./node-server-identity";

const dir = mkdtempSync(join(tmpdir(), "node-server-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const cfg = (body: string): string => {
  const p = join(dir, `config-${n++}.json`);
  writeFileSync(p, body);
  return p;
};

describe("nodeIdentityFromConfig", () => {
  it("读出 node_id / node_name / model(anet node create 写下的形状)", () => {
    const p = cfg(JSON.stringify({ anet_version: "0.1.0", node_id: "n_0000abcd", node_name: "node-a", runtime: "claude-code-cli", model: "sonnet", token: "ntok_x" }));
    expect(nodeIdentityFromConfig(p)).toEqual({ node_id: "n_0000abcd", node_name: "node-a", model: "sonnet" });
  });

  it("不带 token 等其它字段出去", () => {
    const p = cfg(JSON.stringify({ node_id: "n_1", token: "ntok_secret", hub: "http://x" }));
    expect(Object.keys(nodeIdentityFromConfig(p))).toEqual(["node_id"]);
  });

  it("旧配置没有 node_id ⇒ 不发这个字段(不编一个)", () => {
    const p = cfg(JSON.stringify({ node_name: "legacy", runtime: "claude-code-cli" }));
    const id = nodeIdentityFromConfig(p);
    expect(id.node_id).toBeUndefined();
    expect("node_id" in id).toBe(false);
    expect(id.node_name).toBe("legacy");
  });

  it("两端空白去掉;空串 / 纯空白当没有", () => {
    expect(nodeIdentityFromConfig(cfg(JSON.stringify({ node_id: "  n_2  " }))).node_id).toBe("n_2");
    expect(nodeIdentityFromConfig(cfg(JSON.stringify({ node_id: "" }))).node_id).toBeUndefined();
    expect(nodeIdentityFromConfig(cfg(JSON.stringify({ node_id: "   " }))).node_id).toBeUndefined();
  });

  it("非字符串的 node_id 不发(hub schema 是 z.string())", () => {
    for (const v of [123, null, true, ["n_3"], { id: "n_3" }]) {
      expect(nodeIdentityFromConfig(cfg(JSON.stringify({ node_id: v }))).node_id).toBeUndefined();
    }
  });

  it("超过 hub 上限 200 的不发(发了 hub 会整条 report_status 拒掉,连心跳都丢)", () => {
    expect(nodeIdentityFromConfig(cfg(JSON.stringify({ node_id: "n".repeat(200) }))).node_id).toBe("n".repeat(200));
    expect(nodeIdentityFromConfig(cfg(JSON.stringify({ node_id: "n".repeat(201) }))).node_id).toBeUndefined();
  });

  it("坏文件 / 不存在 / 非对象 / 没有路径 ⇒ 空对象,不抛(不能让一个坏配置弄死 MCP 进程)", () => {
    expect(nodeIdentityFromConfig(undefined)).toEqual({});
    expect(nodeIdentityFromConfig(join(dir, "missing.json"))).toEqual({});
    expect(nodeIdentityFromConfig(cfg("{not json"))).toEqual({});
    expect(nodeIdentityFromConfig(cfg("[1,2]"))).toEqual({});
    expect(nodeIdentityFromConfig(cfg("null"))).toEqual({});
    expect(nodeIdentityFromConfig(cfg('"n_4"'))).toEqual({});
  });
});

import { checkNodeIdClaim, nodeIdClaimVerdict } from "./node-server-identity";

describe("nodeIdClaimVerdict", () => {
  it("没有这一行 ⇒ 认领(hub 会插入新行)", () => {
    expect(nodeIdClaimVerdict("n_1", [], "node-a")).toEqual({ claim: true });
  });
  it("行就是自己 ⇒ 认领", () => {
    expect(nodeIdClaimVerdict("n_1", [{ node_id: "n_1", alias: "node-a", config_path: "/x" }], "node-a")).toEqual({ claim: true });
  });
  it("行是别的节点 ⇒ 不认领,带出对方的别名 / runtime / config_path(生产形状)", () => {
    expect(nodeIdClaimVerdict("n_1", [{ node_id: "n_1", alias: "node-b", runtime: "codex-app-server-sdk", config_path: "/b/config.json" }], "node-a"))
      .toEqual({ claim: false, owner: "node-b", runtime: "codex-app-server-sdk", config_path: "/b/config.json" });
  });
  it("旧 hub 不认 ?node_id= 回整张表:只看自己这个 id 的行", () => {
    const rows = [{ node_id: "n_other", alias: "node-b" }, { node_id: "n_1", alias: "node-a" }];
    expect(nodeIdClaimVerdict("n_1", rows, "node-a")).toEqual({ claim: true });
    expect(nodeIdClaimVerdict("n_2", rows, "node-a")).toEqual({ claim: true });
  });
  it("别名为空的行(还没人报过)⇒ 认领", () => {
    expect(nodeIdClaimVerdict("n_1", [{ node_id: "n_1", alias: null }], "node-a")).toEqual({ claim: true });
  });
});

describe("checkNodeIdClaim", () => {
  const fake = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const base = { hubUrl: "http://hub.invalid/", token: "ntok_x", nodeId: "n_1", alias: "node-a" };

  it("查询带 node_id 参数与 Bearer", async () => {
    let seen = ""; let auth = "";
    const f = (async (url: string, init: any) => { seen = url; auth = init.headers.Authorization; return new Response('{"nodes":[]}'); }) as unknown as typeof fetch;
    expect((await checkNodeIdClaim({ ...base, fetchImpl: f })).state).toBe("ok");
    expect(seen).toBe("http://hub.invalid/api/nodes?node_id=n_1");
    expect(auth).toBe("Bearer ntok_x");
  });
  it("没有行 ⇒ ok;是自己 ⇒ ok;是别人 ⇒ conflict", async () => {
    expect((await checkNodeIdClaim({ ...base, fetchImpl: fake(200, { nodes: [] }) })).state).toBe("ok");
    expect((await checkNodeIdClaim({ ...base, fetchImpl: fake(200, { nodes: [{ node_id: "n_1", alias: "node-a" }] }) })).state).toBe("ok");
    expect((await checkNodeIdClaim({ ...base, fetchImpl: fake(200, { nodes: [{ node_id: "n_1", alias: "node-b" }] }) })).state).toBe("conflict");
  });
  it("任何失败都是 unknown(调用方这次不报 node_id,不是当成 ok)", async () => {
    expect((await checkNodeIdClaim({ ...base, fetchImpl: fake(401, { error: "x" }) })).state).toBe("unknown");
    expect((await checkNodeIdClaim({ ...base, fetchImpl: fake(200, { ok: true }) })).state).toBe("unknown");
    expect((await checkNodeIdClaim({ ...base, fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch })).state).toBe("unknown");
    expect((await checkNodeIdClaim({ ...base, fetchImpl: (async () => new Response("<html>")) as unknown as typeof fetch })).state).toBe("unknown");
  });
});
