// app#225 — 规则文件读写的安全边界与门铃循环。
// 跑法：cd agent-node && bun test src/runtime/rules-file.test.ts
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RULES_FILE_MAX_BYTES,
  processRulesFileRequests,
  readRulesFile,
  resolveRulesFilePath,
  rulesFileNameForRuntime,
  writeRulesFile,
} from "./rules-file";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "rules-file-"));
}

describe("文件名只由 runtime 决定", () => {
  test("claude → CLAUDE.md，其余 → AGENTS.md", () => {
    expect(rulesFileNameForRuntime("claude")).toBe("CLAUDE.md");
    for (const rt of ["codex", "grok", "opencode", "codex-app-server", "", undefined, null]) {
      expect(rulesFileNameForRuntime(rt as any)).toBe("AGENTS.md");
    }
  });

  test("路径 = workDir/<文件名>，没有别的成分", () => {
    expect(resolveRulesFilePath("/srv/n1", "claude")).toBe(path.join("/srv/n1", "CLAUDE.md"));
    expect(resolveRulesFilePath("/srv/n1/../n2", "codex")).toBe(path.join("/srv/n2", "AGENTS.md"));
  });
});

describe("读写", () => {
  test("文件不存在 → exists:false 且 content 空，不抛", async () => {
    const d = await tmpDir();
    expect(await readRulesFile(d, "claude")).toEqual({ file_name: "CLAUDE.md", exists: false, content: "" });
  });

  test("写后读回逐字相同，且只产生那一个文件", async () => {
    const d = await tmpDir();
    const body = "# 规则\n\n- 不碰生产 DB\n";
    expect(await writeRulesFile(d, "codex", body)).toEqual({ file_name: "AGENTS.md", bytes: Buffer.byteLength(body) });
    expect(await readRulesFile(d, "codex")).toEqual({ file_name: "AGENTS.md", exists: true, content: body });
    expect((await fs.readdir(d)).sort()).toEqual(["AGENTS.md"]);
  });

  test("超过上限拒绝，且不留半个文件", async () => {
    const d = await tmpDir();
    await expect(writeRulesFile(d, "claude", "x".repeat(RULES_FILE_MAX_BYTES + 1))).rejects.toThrow(/over the/);
    expect(await fs.readdir(d)).toEqual([]);
  });

  test("非字符串内容拒绝", async () => {
    const d = await tmpDir();
    await expect(writeRulesFile(d, "claude", { evil: 1 })).rejects.toThrow(/must be a string/);
  });
});

describe("门铃循环（#225 验收第 5 条：hub 塞路径也写不到别处）", () => {
  function fakeHub(queue: any[]) {
    const calls: Array<{ method: string; params: any }> = [];
    const callCommHub = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "get_rules_file_request") return { ok: true, request: queue.shift() ?? null };
      return { ok: true };
    };
    return { calls, callCommHub };
  }
  const quiet = { log: () => {}, warn: () => {} };

  test("请求里带 path / file_name 一律无视：只写 workDir/CLAUDE.md", async () => {
    const d = await tmpDir();
    const evilTarget = path.join(d, "pwned.txt");
    const hub = fakeHub([
      { request_id: "rf_1", op: "write", content: "hello", path: evilTarget, file_name: "pwned.txt" },
      { request_id: "rf_2", op: "read", path: "/etc/passwd" },
    ]);
    const n = await processRulesFileRequests({ ...hub, runtime: "claude", workDir: d, ...quiet });
    expect(n).toBe(2);
    expect((await fs.readdir(d)).sort()).toEqual(["CLAUDE.md"]);
    const acks = hub.calls.filter(c => c.method === "ack_rules_file_request").map(c => c.params);
    expect(acks).toEqual([
      { request_id: "rf_1", status: "done", file_name: "CLAUDE.md", exists: true },
      { request_id: "rf_2", status: "done", file_name: "CLAUDE.md", exists: true, content: "hello" },
    ]);
  });

  test("操作失败 → ack failed 带原因，循环继续到空", async () => {
    const d = await tmpDir();
    const hub = fakeHub([
      { request_id: "rf_bad", op: "write", content: 42 },
      { request_id: "rf_ok", op: "read" },
    ]);
    expect(await processRulesFileRequests({ ...hub, runtime: "grok", workDir: d, ...quiet })).toBe(2);
    const acks = hub.calls.filter(c => c.method === "ack_rules_file_request").map(c => c.params);
    expect(acks[0]).toMatchObject({ request_id: "rf_bad", status: "failed", file_name: "AGENTS.md" });
    expect(acks[0].error).toMatch(/must be a string/);
    expect(acks[1]).toMatchObject({ request_id: "rf_ok", status: "done", exists: false, content: "" });
  });

  test("没有 pending → 0 条，且不 ack", async () => {
    const hub = fakeHub([]);
    expect(await processRulesFileRequests({ ...hub, runtime: "claude", workDir: await tmpDir(), ...quiet })).toBe(0);
    expect(hub.calls.map(c => c.method)).toEqual(["get_rules_file_request"]);
  });
});
