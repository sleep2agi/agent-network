/**
 * #3095 —— 迟到结果补发的**落盘记录**。
 *
 * 背景：`#3071` 让 bridge 在超时后继续等那一轮，结束时把结果补发回 Hub。
 * 那个观察器活在进程内 —— 节点一重启，正在等的那一轮就变成静默丢失。
 * 而重启不是罕见事件：升级、崩溃、系统重启、运维手工 stop/start 都会发生。
 *
 * 这一版做的是**阶段一：不再静默**。
 *   · 超时那一刻把 (taskId, threadId, turnId, sessionId, deadline) 落盘；
 *   · 补发成功或到期 → 删掉记录；
 *   · 节点启动时扫这个目录：还留着的记录意味着「上次进程没能等到结果」，
 *     此时给原发送方补一条说明，而不是什么都不说。
 *
 * 真正的「重启后续挂观察器」（用 readEntriesAfter 继续读同一个 sessionId）
 * 需要运行时提供读取入口，是这条卡的第二阶段 —— 本文件先把第一阶段的可观测性做掉。
 *
 * 写入必须是原子的：进程可能被 kill -9，半截 JSON 会让扫描逻辑读到脏数据。
 * 做法是 tmp + rename（同一文件系统内 rename 是原子的）。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LateReplyRecord = {
  taskId: string;
  threadId: string;
  turnId: string;
  sessionId: string;
  /** ISO 时间：超时那一刻。 */
  armedAt: string;
  /** ISO 时间：观察窗口的硬上限。 */
  deadlineAt: string;
};

export const PENDING_DIR_NAME = "pending-late-replies";

export function pendingDir(nodeDir: string): string {
  return join(nodeDir, PENDING_DIR_NAME);
}

/** 文件名只用 taskId（幂等键），并做最小净化，避免 taskId 里出现路径分隔符。 */
function recordName(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${safe || "unknown"}.json`;
}

/** 原子写：先写 tmp，再 rename 覆盖。失败只返回 false，绝不抛出（补发链路不能因此中断）。 */
export function saveLateReplyRecord(nodeDir: string, record: LateReplyRecord): boolean {
  const dir = pendingDir(nodeDir);
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, recordName(record.taskId));
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export function clearLateReplyRecord(nodeDir: string, taskId: string): boolean {
  try {
    rmSync(join(pendingDir(nodeDir), recordName(taskId)), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读出所有遗留记录（= 上次进程没等到结果的）。
 * 半截/损坏的 JSON 直接跳过并删除 —— 它已经没有信息价值，留着只会让每次启动都读一遍垃圾。
 */
export function listLateReplyRecords(nodeDir: string): { records: LateReplyRecord[]; corrupted: number } {
  const dir = pendingDir(nodeDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { records: [], corrupted: 0 };
  }
  const records: LateReplyRecord[] = [];
  let corrupted = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8")) as Partial<LateReplyRecord>;
      if (
        typeof parsed?.taskId !== "string" || !parsed.taskId ||
        typeof parsed?.threadId !== "string" || !parsed.threadId ||
        typeof parsed?.turnId !== "string" || !parsed.turnId
      ) {
        throw new Error("incomplete record");
      }
      records.push({
        taskId: parsed.taskId,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : parsed.threadId,
        armedAt: typeof parsed.armedAt === "string" ? parsed.armedAt : "",
        deadlineAt: typeof parsed.deadlineAt === "string" ? parsed.deadlineAt : "",
      });
    } catch {
      corrupted += 1;
      try { rmSync(full, { force: true }); } catch { /* 删不掉也不阻塞启动 */ }
    }
  }
  return { records, corrupted };
}
