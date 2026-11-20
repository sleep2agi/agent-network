// agy「登录入口」的 daemon 侧实现（设计稿：handoff/agy-login-channel-design.md）。
//
// 安全边界（全部在这个文件里）：
//   · 只允许 spawn `agy acp --login` —— binary 与 argv 都写死，请求体里没有
//     任何命令/路径字段；
//   · 授权码只写进子进程 stdin，不写日志、不进返回值；
//   · 单并发：同一节点同时只保留一个登录会话；新的 start 会先取消旧的；
//   · 生命周期：URL 10s 内拿不到 → no_url；5 分钟没 submit → expired；
//     daemon 退出/取消 → 杀掉子进程并彻底清理。
//
// 真机事实（agy 1.5.13，2026-11-20 实测）：
//   stdout 先打印 "Open this link ...:" 再打 URL，然后提示
//   "Then paste the authorization code, or the full URL ..., and press Enter:"，
//   读一行 stdin；成功 exit 0，取消/空输入 exit 1。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface AgyLoginSession {
  loginId: string;
  url: string;
  /** epoch ms */
  expiresAt: number;
}

export type AgyLoginFailure = "no_url" | "expired" | "cancelled" | "timeout" | "invalid_code" | "unknown";

export interface AgyLoginManagerDeps {
  /** 默认 `agy`（PATH 或 AGY_BIN）。测试注假 CLI。 */
  binary?: string;
  /** 测试注入的 spawn（签名与 node:child_process.spawn 一致的最小面）。 */
  spawnImpl?: typeof spawn;
  now?: () => number;
  urlTimeoutMs?: number;
  submitTimeoutMs?: number;
  ttlMs?: number;
  /** 测试注入随机 id，便于断言。 */
  nextId?: () => string;
}

interface Live {
  id: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  expiresAt: number;
  url: string;
  exited: boolean;
  exitCode: number | null;
  stderr: string;
}

const URL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;

export function createAgyLoginManager(deps: AgyLoginManagerDeps = {}) {
  const binary = deps.binary ?? process.env.AGY_BIN ?? "agy";
  const spawnImpl = deps.spawnImpl ?? spawn;
  const now = deps.now ?? (() => Date.now());
  const urlTimeoutMs = deps.urlTimeoutMs ?? 10_000;
  const submitTimeoutMs = deps.submitTimeoutMs ?? 30_000;
  const ttlMs = deps.ttlMs ?? 5 * 60_000;
  const nextId = deps.nextId ?? (() => randomUUID());

  let live: Live | null = null;

  const kill = (l: Live) => {
    try { if (!l.exited) l.child.kill("SIGTERM"); } catch { /* already gone */ }
  };

  const cleanup = (l: Live) => {
    // stdin 关掉，防止子进程在 EOF 上挂着；退出码由 exited 标记接管。
    try { l.child.stdin.end(); } catch { /* ignore */ }
    kill(l);
    if (live?.id === l.id) live = null;
  };

  return {
    /** 当前是否有未完成的登录会话（测试/诊断用）。 */
    current(): AgyLoginSession | null {
      if (!live) return null;
      if (now() > live.expiresAt) { cleanup(live); return null; }
      return { loginId: live.id, url: live.url, expiresAt: live.expiresAt };
    },

    /** `agy acp --login`：等 URL 出现（≤10s），进程保持存活等 submit。 */
    async start(): Promise<{ ok: true; session: AgyLoginSession } | { ok: false; reason: AgyLoginFailure }> {
      if (live) cleanup(live);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnImpl(binary, ["acp", "--login"], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      } catch {
        return { ok: false, reason: "unknown" };
      }
      const entry: Live = {
        id: nextId(), child, startedAt: now(), expiresAt: now() + ttlMs,
        url: "", exited: false, exitCode: null, stderr: "",
      };
      live = entry;
      child.on("exit", code => { entry.exited = true; entry.exitCode = code; });
      child.on("error", () => { entry.exited = true; entry.exitCode = -1; });
      child.stderr.on("data", (buf: Buffer) => { entry.stderr = (entry.stderr + buf.toString("utf8")).slice(-4000); });

      const url = await new Promise<string | null>(resolve => {
        let settled = false;
        const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => done(null), urlTimeoutMs);
        child.stdout.on("data", (buf: Buffer) => {
          const text = buf.toString("utf8");
          const m = text.match(URL_RE);
          if (m) { clearTimeout(timer); done(m[0]); }
        });
        child.on("exit", () => { clearTimeout(timer); done(null); });
      });
      if (!url) { cleanup(entry); return { ok: false, reason: "no_url" }; }
      entry.url = url;
      return { ok: true, session: { loginId: entry.id, url, expiresAt: entry.expiresAt } };
    },

    /** 把授权码写进 stdin，等退出（≤30s）。退出码 0 = 成功。 */
    async submit(loginId: string, code: string): Promise<{ ok: true } | { ok: false; reason: AgyLoginFailure }> {
      if (!live || live.id !== loginId) return { ok: false, reason: "expired" };
      if (now() > live.expiresAt) { cleanup(live); return { ok: false, reason: "expired" }; }
      const entry = live;
      if (entry.exited) { cleanup(entry); return { ok: false, reason: entry.exitCode === 0 ? "unknown" : "invalid_code" }; }
      try {
        entry.child.stdin.write(`${code.trim()}\n`);
      } catch {
        cleanup(entry); return { ok: false, reason: "unknown" };
      }
      const code_ = await new Promise<number | null>(resolve => {
        if (entry.exited) { resolve(entry.exitCode); return; }
        const timer = setTimeout(() => { entry.exited || kill(entry); resolve(null); }, submitTimeoutMs);
        entry.child.on("exit", c => { clearTimeout(timer); resolve(c); });
      });
      cleanup(entry);
      if (code_ === null) return { ok: false, reason: "timeout" };
      if (code_ === 0) return { ok: true };
      return { ok: false, reason: entry.stderr ? (entry.stderr.match(/invalid|expired|cancel/i) ? "invalid_code" : "unknown") : "invalid_code" };
    },

    cancel(loginId?: string): boolean {
      if (!live) return false;
      if (loginId && live.id !== loginId) return false;
      cleanup(live);
      return true;
    },
  };
}

export type AgyLoginManager = ReturnType<typeof createAgyLoginManager>;
