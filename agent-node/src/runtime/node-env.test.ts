// 节点环境变量(node-env.ts)+ 门铃分派(rules-file.ts 的 env_* 分支)。
//
// 钉住的边界:
//   1. 原子写:临时文件 + rename,不留临时文件;写前 `.prev` 备份。
//   2. 权限 0600;原文件更严(0400)保留更严的;拒绝软链接 / 硬链接。
//   3. 值只写不读:list 只有键和元数据;日志、ack、错误文案里都没有值;
//      config.json 解析失败的报错不带原文。
//   4. 键规则在节点侧再挡一遍(hub 之外的第二道)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWritePrivate, envConfigMode, envKeyProblem, EnvOpError, fileEnvStore, listNodeEnv, parseEnvRequestContent,
  safeEnvErrorMessage, setNodeEnv, unsetNodeEnv,
} from "./node-env";
import { processRulesFileRequests } from "./rules-file";

const SECRET = "sk-NODEENV-4b1d-SECRET-VALUE-do-not-leak";
let dir = "";
let cfgPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "node-env-"));
  cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ alias: "n1", runtime: "claude", token: "ntok_x", env: { EXISTING: "abc", REF_KEY: { _envRef: "SOME_REF" } } }, null, 2), { mode: 0o600 });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf8"));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("setNodeEnv / unsetNodeEnv — atomic write, .prev, mode", () => {
  test("writes the key, keeps everything else, backs up .prev, leaves no temp file", () => {
    const before = readFileSync(cfgPath, "utf8");
    const r = setNodeEnv(fileEnvStore(cfgPath), "API_KEY", SECRET, "remote");
    expect(r.result).toEqual({ key: "API_KEY", set: true, length: SECRET.length, requires_restart: true, restart: "remote" });
    const cfg = readCfg();
    expect(cfg.env.API_KEY).toBe(SECRET);
    expect(cfg.env.EXISTING).toBe("abc");
    expect(cfg.env.REF_KEY).toEqual({ _envRef: "SOME_REF" });
    expect(cfg.token).toBe("ntok_x");
    expect(readFileSync(`${cfgPath}.prev`, "utf8")).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(["config.json", "config.json.prev"]);
    expect(mode(cfgPath)).toBe(0o600);
    expect(mode(`${cfgPath}.prev`)).toBe(0o600);
    expect(r.env.API_KEY).toBe(SECRET);
  });

  test("a looser file is tightened to 0600; a stricter one (0400) stays 0400", () => {
    chmodSync(cfgPath, 0o644);
    setNodeEnv(fileEnvStore(cfgPath), "A1", "v", "manual");
    expect(mode(cfgPath)).toBe(0o600);
    chmodSync(cfgPath, 0o400);
    setNodeEnv(fileEnvStore(cfgPath), "A2", "v", "manual");
    expect(mode(cfgPath)).toBe(0o400);
    expect(readCfg().env.A2).toBe("v");
    expect(envConfigMode(0o100644)).toBe(0o600);
    expect(envConfigMode(0o100400)).toBe(0o400);
    expect(envConfigMode(undefined)).toBe(0o600);
  });

  test("config.json with no env block gets one", () => {
    writeFileSync(cfgPath, JSON.stringify({ alias: "n1" }), { mode: 0o600 });
    setNodeEnv(fileEnvStore(cfgPath), "API_KEY", "v", "manual");
    expect(readCfg()).toEqual({ alias: "n1", env: { API_KEY: "v" } });
  });

  test("unset removes the key (existed=true) and is a no-op without a write when absent", () => {
    const r = unsetNodeEnv(fileEnvStore(cfgPath), "EXISTING", "remote");
    expect(r.result).toEqual({ key: "EXISTING", set: false, existed: true, requires_restart: true, restart: "remote" });
    expect(readCfg().env.EXISTING).toBeUndefined();
    rmSync(`${cfgPath}.prev`);
    const r2 = unsetNodeEnv(fileEnvStore(cfgPath), "NOT_THERE", "remote");
    expect(r2.result.existed).toBe(false);
    expect(r2.env).toBeNull();
    expect(existsSync(`${cfgPath}.prev`)).toBe(false);
  });

  test("refuses a symlinked or hard-linked config.json", () => {
    const real = join(dir, "real.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    expect(() => setNodeEnv(fileEnvStore(link), "API_KEY", "v", "manual")).toThrow(EnvOpError);
    const hard = join(dir, "hard.json");
    linkSync(real, hard);
    expect(() => setNodeEnv(fileEnvStore(hard), "API_KEY", "v", "manual")).toThrow(/link/);
    expect(readFileSync(real, "utf8")).toBe("{}");
  });

  test("reserved / malformed keys and bad values are refused on the node too; the file is untouched", () => {
    const before = readFileSync(cfgPath, "utf8");
    for (const k of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "COMMHUB_TOKEN", "ANET_NODE_MARKER", "lower"]) {
      expect(() => setNodeEnv(fileEnvStore(cfgPath), k, "v", "manual")).toThrow(EnvOpError);
    }
    expect(() => setNodeEnv(fileEnvStore(cfgPath), "OK_KEY", "", "manual")).toThrow(EnvOpError);
    expect(() => setNodeEnv(fileEnvStore(cfgPath), "OK_KEY", "a\u0000b", "manual")).toThrow(EnvOpError);
    expect(() => setNodeEnv(fileEnvStore(cfgPath), "OK_KEY", "x".repeat(8193), "manual")).toThrow(EnvOpError);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
    expect(envKeyProblem("DEEPSEEK_API_KEY")).toBeNull();
  });

  test("a config.json that is not JSON is left alone, and the error does not quote it", () => {
    writeFileSync(cfgPath, `{"token":"${SECRET}", oops`, { mode: 0o600 });
    let msg = "";
    try { setNodeEnv(fileEnvStore(cfgPath), "API_KEY", "v", "manual"); } catch (e) { msg = safeEnvErrorMessage(e); }
    expect(msg).toBe("config.json is not valid JSON; not touching it");
    expect(msg).not.toContain(SECRET);
    expect(readFileSync(cfgPath, "utf8")).toContain("oops");
  });

  test("atomicWritePrivate cleans its temp file when rename fails", () => {
    const target = join(dir, "sub");
    // rename a file onto an existing non-empty directory fails
    require("node:fs").mkdirSync(target);
    writeFileSync(join(target, "x"), "x");
    expect(() => atomicWritePrivate(target, "body", 0o600)).toThrow();
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp"))).toEqual([]);
  });

  test("safeEnvErrorMessage never passes a foreign message through", () => {
    expect(safeEnvErrorMessage(new Error(`EACCES: ${SECRET}`))).toBe("config write failed");
    expect(safeEnvErrorMessage(Object.assign(new Error(`x ${SECRET}`), { code: "EACCES" }))).toBe("config write failed (EACCES)");
    expect(safeEnvErrorMessage(new EnvOpError("fixed text"))).toBe("fixed text");
    expect(() => parseEnvRequestContent(`{"key":"A","value":"${SECRET}"`)).toThrow("env request body is not valid JSON");
  });
});

describe("listNodeEnv — keys and metadata only", () => {
  test("no values; in_effect compares with the running process env; ref kind; reserved flagged", () => {
    writeFileSync(cfgPath, JSON.stringify({ env: { API_KEY: SECRET, STALE: "new", HOME_DIR: "~/x", REF_KEY: { _envRef: "R" }, PATH: "/bin", "lower": "x" } }), { mode: 0o600 });
    const r = listNodeEnv(fileEnvStore(cfgPath), { processEnv: { API_KEY: SECRET, STALE: "old", HOME_DIR: "/home/user/x", REF_KEY: "resolved" }, home: "/home/user", restart: "remote" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r).toEqual({
      keys: [
        { key: "API_KEY", set: true, length: SECRET.length, in_effect: true, kind: "plain" },
        { key: "HOME_DIR", set: true, length: 3, in_effect: true, kind: "plain" },
        { key: "PATH", set: true, length: 4, in_effect: false, kind: "plain", reserved: true },
        { key: "REF_KEY", set: true, length: 8, in_effect: true, kind: "ref" },
        { key: "STALE", set: true, length: 3, in_effect: false, kind: "plain" },
      ],
      restart: "remote",
    });
  });

  test("length counts characters (code points), not bytes", () => {
    writeFileSync(cfgPath, JSON.stringify({ env: { K: "密钥🔑" } }), { mode: 0o600 });
    expect(listNodeEnv(fileEnvStore(cfgPath), { processEnv: {}, restart: "manual" }).keys[0].length).toBe(3);
  });
});

describe("processRulesFileRequests env_* — the value never reaches a log or an ack", () => {
  function fakeHub(requests: any[]) {
    const acks: any[] = [];
    const callCommHub = async (method: string, params: any) => {
      if (method === "get_rules_file_request") return { ok: true, request: requests.shift() ?? null };
      if (method === "ack_rules_file_request") { acks.push(params); return { ok: true }; }
      throw new Error(`unexpected ${method}`);
    };
    return { acks, callCommHub };
  }

  test("set → list → unset round trip; logs / acks carry only key + length", async () => {
    const lines: string[] = [];
    const written: any[] = [];
    const hub = fakeHub([
      { request_id: "r1", op: "env_set", content: JSON.stringify({ key: "API_KEY", value: SECRET }) },
      { request_id: "r2", op: "env_list" },
      { request_id: "r3", op: "env_unset", content: JSON.stringify({ key: "EXISTING" }) },
      { request_id: "r4", op: "env_set", content: JSON.stringify({ key: "PATH", value: SECRET }) },
      { request_id: "r5", op: "env_set", content: `{"key":"A","value":"${SECRET}"` },
    ]);
    const n = await processRulesFileRequests({
      callCommHub: hub.callCommHub, runtime: "claude", workDir: dir,
      log: (m) => lines.push(m), warn: (m) => lines.push(m),
      env: { store: fileEnvStore(cfgPath), restart: "remote", processEnv: {}, onWritten: (e) => written.push(Object.keys(e)) },
    });
    expect(n).toBe(5);
    expect(readCfg().env.API_KEY).toBe(SECRET);
    expect(readCfg().env.EXISTING).toBeUndefined();
    expect(hub.acks.map((a) => a.status)).toEqual(["done", "done", "done", "failed", "failed"]);
    expect(JSON.parse(hub.acks[0].content)).toEqual({ key: "API_KEY", set: true, length: SECRET.length, requires_restart: true, restart: "remote" });
    expect(JSON.parse(hub.acks[1].content).keys.map((k: any) => k.key)).toEqual(["API_KEY", "EXISTING", "REF_KEY"]);
    expect(hub.acks[3].error).toContain("reserved_env_key");
    expect(hub.acks[4].error).toBe("env request body is not valid JSON");
    expect(written).toEqual([["EXISTING", "REF_KEY", "API_KEY"], ["REF_KEY", "API_KEY"]]);
    for (const a of hub.acks) expect(JSON.stringify(a)).not.toContain(SECRET);
    for (const l of lines) expect(l).not.toContain(SECRET);
    expect(lines.some((l) => l.includes("[env] set API_KEY length="))).toBe(true);
  });

  test("a node without a config file answers env_* with failed, not silence", async () => {
    const hub = fakeHub([{ request_id: "r1", op: "env_list" }]);
    await processRulesFileRequests({ callCommHub: hub.callCommHub, runtime: "codex", workDir: dir, log: () => {}, warn: () => {} });
    expect(hub.acks[0]).toMatchObject({ status: "failed", file_name: "env" });
    expect(hub.acks[0].error).toContain("no config.json");
  });
});
