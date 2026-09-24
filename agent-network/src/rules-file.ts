// app#225 — 节点规则文件（AGENTS.md / CLAUDE.md）的远程读写。
//
// 这条链路的安全边界只有一条，而且全在这个文件里：
//
//   🔴 文件名由节点按自己的 RUNTIME 决定，目录固定是节点进程的工作目录。
//      hub 发来的请求里**没有**路径字段；就算有（旧 hub / 恶意 hub 塞一个
//      `path` / `file_name` 进来），这里也不读它 —— resolveRulesFilePath 的
//      输入只有 (workDir, runtime)，输出永远是 <workDir>/<CLAUDE.md|AGENTS.md>。
//
// 形状照抄 RFC-024 config-apply（cli.ts processConfigUpdate）：门铃 → 拉 →
// 做 → ack；任何失败都 ack failed 带原因，客户端立刻看到而不是等超时。

import { promises as fs } from "node:fs";
import path from "node:path";

export const RULES_FILE_MAX_BYTES = 256 * 1024;

export type RulesFileName = "CLAUDE.md" | "AGENTS.md";

/** claude 节点读 CLAUDE.md，其余运行时（codex / grok / opencode / codex-app-server）读 AGENTS.md。 */
export function rulesFileNameForRuntime(runtime: string | null | undefined): RulesFileName {
  return runtime === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

/**
 * 唯一的路径来源。输入里没有任何调用方可控的路径成分；结果再用 dirname
 * 反查一遍，防止将来有人给 workDir 传进带 `..` 的东西。
 */
export function resolveRulesFilePath(workDir: string, runtime: string | null | undefined): string {
  const base = path.resolve(workDir);
  const name = rulesFileNameForRuntime(runtime);
  const full = path.join(base, name);
  if (path.dirname(full) !== base || path.basename(full) !== name) {
    throw new Error(`rules file path escaped work dir: ${full}`);
  }
  return full;
}

export interface RulesFileReadResult {
  file_name: RulesFileName;
  exists: boolean;
  content: string;
}

export async function readRulesFile(workDir: string, runtime: string | null | undefined): Promise<RulesFileReadResult> {
  const file = resolveRulesFilePath(workDir, runtime);
  const file_name = rulesFileNameForRuntime(runtime);
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error(`${file_name} is not a regular file`);
    if (st.size > RULES_FILE_MAX_BYTES) {
      throw new Error(`${file_name} is ${st.size} bytes, over the ${RULES_FILE_MAX_BYTES} byte limit`);
    }
    const content = await fs.readFile(file, "utf8");
    return { file_name, exists: true, content };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { file_name, exists: false, content: "" };
    throw err;
  }
}

export interface RulesFileWriteResult {
  file_name: RulesFileName;
  bytes: number;
}

/** 临时文件 + rename，写一半掉电不会留下半个规则文件。 */
export async function writeRulesFile(
  workDir: string,
  runtime: string | null | undefined,
  content: unknown,
): Promise<RulesFileWriteResult> {
  if (typeof content !== "string") throw new Error("rules file content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > RULES_FILE_MAX_BYTES) {
    throw new Error(`content is ${bytes} bytes, over the ${RULES_FILE_MAX_BYTES} byte limit`);
  }
  const file = resolveRulesFilePath(workDir, runtime);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { file_name: rulesFileNameForRuntime(runtime), bytes };
}

export interface RulesFileRequest {
  request_id: string;
  op: "read" | "write";
  content?: string;
}

export interface ProcessRulesFileDeps {
  callCommHub: (method: string, params: Record<string, unknown>) => Promise<any>;
  runtime: string | null | undefined;
  workDir: string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

/** 一次门铃最多处理这么多条，防止 hub 侧异常堆积把节点拖进死循环。 */
export const RULES_FILE_MAX_PER_DOORBELL = 8;

/**
 * 门铃处理器：拉 pending 请求直到空，每条 ack done / failed。
 * 返回处理条数（测试用）。
 */
export async function processRulesFileRequests(deps: ProcessRulesFileDeps): Promise<number> {
  let handled = 0;
  for (let i = 0; i < RULES_FILE_MAX_PER_DOORBELL; i++) {
    const pull = await deps.callCommHub("get_rules_file_request", {});
    const req = pull?.request as RulesFileRequest | null | undefined;
    if (!req || typeof req.request_id !== "string") return handled;
    handled += 1;
    try {
      if (req.op === "read") {
        const r = await readRulesFile(deps.workDir, deps.runtime);
        await deps.callCommHub("ack_rules_file_request", {
          request_id: req.request_id,
          status: "done",
          file_name: r.file_name,
          exists: r.exists,
          content: r.content,
        });
        deps.log(`[rules-file] read ${r.file_name} exists=${r.exists} bytes=${Buffer.byteLength(r.content, "utf8")} (${req.request_id})`);
      } else if (req.op === "write") {
        const r = await writeRulesFile(deps.workDir, deps.runtime, req.content);
        await deps.callCommHub("ack_rules_file_request", {
          request_id: req.request_id,
          status: "done",
          file_name: r.file_name,
          exists: true,
        });
        deps.log(`[rules-file] wrote ${r.file_name} bytes=${r.bytes} (${req.request_id})`);
      } else {
        throw new Error(`unknown op ${String((req as any).op)}`);
      }
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 500);
      deps.warn(`[rules-file] ${req.op} failed (${req.request_id}): ${msg}`);
      try {
        await deps.callCommHub("ack_rules_file_request", {
          request_id: req.request_id,
          status: "failed",
          file_name: rulesFileNameForRuntime(deps.runtime),
          error: msg,
        });
      } catch (ackErr: any) {
        deps.warn(`[rules-file] ack failed for ${req.request_id}: ${ackErr?.message || ackErr}`);
      }
    }
  }
  return handled;
}
