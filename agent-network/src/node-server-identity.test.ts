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
