import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainRulesFileRequests, handleRulesFileEvent } from "./node-server-rules-file";

// app#225 follow-up —— claude-code 会话节点(node-server)答规则文件门铃。
// 假 hub:按顺序吐请求,记录 ack。文件名必须是 CLAUDE.md、目录必须是传入的 workDir。

function fakeHub(queue: any[]) {
  const acks: any[] = [];
  const calls: string[] = [];
  const callCommHub = async (method: string, params: Record<string, unknown>) => {
    calls.push(method);
    if (method === "get_rules_file_request") return { ok: true, request: queue.shift() ?? null };
    if (method === "ack_rules_file_request") { acks.push(params); return { ok: true }; }
    throw new Error(`unexpected ${method}`);
  };
  return { callCommHub, acks, calls };
}

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ns-rules-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("node-server rules_file doorbell", () => {
  test("read: returns CLAUDE.md from the work dir, never AGENTS.md", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "CLAUDE.md"), "# claude rules\n");
    writeFileSync(join(dir, "AGENTS.md"), "# agents rules (must not be read)\n");
    const hub = fakeHub([{ request_id: "rf_1", op: "read" }]);
    const handled = await handleRulesFileEvent({ type: "rules_file" }, { callCommHub: hub.callCommHub, workDir: dir, log: () => {} });
    expect(handled).toBe(true);
    expect(hub.acks).toEqual([{ request_id: "rf_1", status: "done", file_name: "CLAUDE.md", exists: true, content: "# claude rules\n" }]);
  });

  test("write: replaces CLAUDE.md in the work dir atomically and leaves no temp file", async () => {
    const dir = tmp();
    const hub = fakeHub([{ request_id: "rf_2", op: "write", content: "new rules\n" }]);
    await handleRulesFileEvent({ type: "rules_file" }, { callCommHub: hub.callCommHub, workDir: dir, log: () => {} });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("new rules\n");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(hub.acks[0]).toMatchObject({ request_id: "rf_2", status: "done", file_name: "CLAUDE.md", exists: true });
  });

  test("missing file reads as exists:false with empty content, not a failure", async () => {
    const hub = fakeHub([{ request_id: "rf_3", op: "read" }]);
    await drainRulesFileRequests({ callCommHub: hub.callCommHub, workDir: tmp(), log: () => {} }, "test");
    expect(hub.acks).toEqual([{ request_id: "rf_3", status: "done", file_name: "CLAUDE.md", exists: false, content: "" }]);
  });

  test("a directory named CLAUDE.md is refused with an ack, not a crash", async () => {
    const dir = tmp();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "CLAUDE.md"));
    const hub = fakeHub([{ request_id: "rf_4", op: "read" }]);
    await drainRulesFileRequests({ callCommHub: hub.callCommHub, workDir: dir, log: () => {} }, "test");
    expect(hub.acks[0]).toMatchObject({ request_id: "rf_4", status: "failed", file_name: "CLAUDE.md" });
  });

  test("other SSE events are not consumed and trigger no hub call", async () => {
    const hub = fakeHub([{ request_id: "rf_5", op: "read" }]);
    for (const ev of [{ type: "new_task" }, { type: "connected" }, { type: "rules_filex" }, null, undefined, {}]) {
      expect(await handleRulesFileEvent(ev as any, { callCommHub: hub.callCommHub, workDir: tmp(), log: () => {} })).toBe(false);
    }
    expect(hub.calls).toEqual([]);
  });

  test("a hub error during the drain is logged, never thrown into the SSE loop", async () => {
    const lines: string[] = [];
    const n = await drainRulesFileRequests({ callCommHub: async () => { throw new Error("hub down"); }, workDir: tmp(), log: (m) => lines.push(m) }, "connect catch-up");
    expect(n).toBe(0);
    expect(lines.some((l) => l.includes("connect catch-up handler failed") && l.includes("hub down"))).toBe(true);
  });

  test("skills_list / skill_read: claude skill roots (project .claude/skills + user ~/.claude/skills)", async () => {
    const dir = tmp();
    const home = tmp();
    mkdirSync(join(dir, ".claude", "skills", "ship"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "ship", "SKILL.md"), "---\ndescription: project ship\n---\nsteps\n");
    mkdirSync(join(home, ".claude", "skills", "notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "notes", "SKILL.md"), "---\ndescription: user notes\n---\n");
    const hub = fakeHub([
      { request_id: "s1", op: "skills_list" },
      { request_id: "s2", op: "skill_read", content: "ship" },
      { request_id: "s3", op: "skill_read", content: "../CLAUDE.md" },
    ]);
    await drainRulesFileRequests({ callCommHub: hub.callCommHub, workDir: dir, home, log: () => {} }, "test");
    expect(hub.acks.map((a) => [a.request_id, a.status])).toEqual([["s1", "done"], ["s2", "done"], ["s3", "failed"]]);
    expect(JSON.parse(hub.acks[0].content).skills).toEqual([
      { name: "ship", scope: "project", path_rel: ".claude/skills/ship/SKILL.md", description: "project ship" },
      { name: "notes", scope: "user", path_rel: "~/.claude/skills/notes/SKILL.md", description: "user notes" },
    ]);
    expect(JSON.parse(hub.acks[1].content).content).toContain("steps");
    expect(hub.acks[2].error).toBe("invalid skill name");
  });
});
