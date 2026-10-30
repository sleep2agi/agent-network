import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearLateReplyRecord, listLateReplyRecords, pendingDir, saveLateReplyRecord } from "./late-reply-store";

// #3095 —— 超时后的观察器活在进程内：节点一重启，正在等的那一轮就静默丢失。
// 这一版做「不再静默」：落盘 → 启动时能识别 → 给发送方补一条说明。
function freshDir() {
  return mkdtempSync(join(tmpdir(), "late-store-"));
}

const rec = (taskId: string) => ({
  taskId,
  threadId: "ses_x",
  turnId: "msg_y",
  sessionId: "ses_x",
  armedAt: "2026-10-30T08:00:00.000Z",
  deadlineAt: "2026-10-30T09:00:00.000Z",
});

describe("#3095 迟到结果的落盘记录", () => {
  test("存进去能读出来（含 thread/turn）", () => {
    const dir = freshDir();
    expect(saveLateReplyRecord(dir, rec("t1"))).toBe(true);
    const { records, corrupted } = listLateReplyRecords(dir);
    expect(corrupted).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ taskId: "t1", threadId: "ses_x", turnId: "msg_y" });
  });

  test("同一 taskId 重复落盘是覆盖，不会长出两条（幂等键 = taskId）", () => {
    const dir = freshDir();
    saveLateReplyRecord(dir, rec("t1"));
    saveLateReplyRecord(dir, { ...rec("t1"), turnId: "msg_z" });
    const { records } = listLateReplyRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].turnId).toBe("msg_z");
  });

  test("写入用 tmp + rename：目录里不残留 .tmp", () => {
    const dir = freshDir();
    saveLateReplyRecord(dir, rec("t1"));
    const names = readdirSync(pendingDir(dir));
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(names).toEqual(["t1.json"]);
  });

  test("半截 JSON（kill -9 留下的）被跳过并清除，不影响其他记录", () => {
    const dir = freshDir();
    saveLateReplyRecord(dir, rec("good"));
    writeFileSync(join(pendingDir(dir), "bad.json"), '{"taskId":"bad","threadId":', "utf8");
    const { records, corrupted } = listLateReplyRecords(dir);
    expect(corrupted).toBe(1);
    expect(records.map((r) => r.taskId)).toEqual(["good"]);
    expect(readdirSync(pendingDir(dir))).not.toContain("bad.json");
  });

  test("字段不全的记录也按损坏处理（不能拿它去补发）", () => {
    const dir = freshDir();
    mkdirSync(pendingDir(dir), { recursive: true });
    writeFileSync(join(pendingDir(dir), "partial.json"), JSON.stringify({ taskId: "x" }), "utf8");
    const { records, corrupted } = listLateReplyRecords(dir);
    expect(corrupted).toBe(1);
    expect(records).toHaveLength(0);
  });

  test("补发成功后清除记录；清除不存在的记录不报错", () => {
    const dir = freshDir();
    saveLateReplyRecord(dir, rec("t1"));
    expect(clearLateReplyRecord(dir, "t1")).toBe(true);
    expect(listLateReplyRecords(dir).records).toHaveLength(0);
    expect(clearLateReplyRecord(dir, "never-existed")).toBe(true);
  });

  test("目录不存在时读取返回空而不是抛错（首次启动的常态）", () => {
    const dir = freshDir();
    const out = listLateReplyRecords(dir);
    expect(out).toEqual({ records: [], corrupted: 0 });
  });

  test("taskId 里的路径分隔符被净化，不会写到目录之外", () => {
    const dir = freshDir();
    saveLateReplyRecord(dir, rec("../../etc/passwd"));
    const names = readdirSync(pendingDir(dir));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain("/");
    expect(readFileSync(join(pendingDir(dir), names[0]), "utf8")).toContain("../../etc/passwd");
  });
});
