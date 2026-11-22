// #5321 —— agy（antigravity）的模型清单 + 登录状态上报。
//
// 为什么需要：App 的模型面板只认 OpenCode V2（isOpenCodeV2Node），agy 节点既没有模型清单
// 也没有登录状态字段 ⇒ 面板只能显示「切不了」。这里补的是**数据**，UI 在 App 侧第三段做。
//
// 口径（负责人 2026-11-22）：
//   · 来源必须是节点真实调用 `agy models`，不许内置清单兜底、不许猜；
//   · 读不到（没装 / 命令不存在 / 超时 / 输出形状不对）⇒ models 不报，login_state = unknown；
//   · 明确未登录（输出里有登录提示类文本）⇒ needs_login；
//   · 探测异常**绝不影响心跳**：调用方只在缓存里取值，探测在后台跑。
import { spawnSync } from "node:child_process";

export type AgyLoginState = "logged_in" | "needs_login" | "unknown";

export interface AgyProbeResult {
  models: string[] | null;
  loginState: AgyLoginState;
}

export interface AgyProbeDeps {
  binary: string;
  run?: (bin: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  timeoutMs?: number;
}

const NEEDS_LOGIN_RE = /(please (log ?in|sign ?in)|run:? ?agy (acp )?--?login|no supported non-interactive auth method|not (logged|signed) in|unauthori[sz]ed)/i;

/** 把 `agy models` 的输出解析成模型名列表。只接受像 `provider/model` 或纯模型名的单行；畸形行丢弃。 */
export function parseAgyModels(stdout: string): string[] | null {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const models = lines.filter(l => /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,120}$/.test(l) && !/^(available|models|usage)/i.test(l));
  return models.length ? models : null;
}

/** 一次探测。**永不抛出**：任何异常都是 unknown。 */
export function probeAgy(deps: AgyProbeDeps): AgyProbeResult {
  const run = deps.run ?? ((bin, args) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: deps.timeoutMs ?? 15_000 });
    return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  });
  let out: { status: number | null; stdout: string; stderr: string };
  try {
    out = run(deps.binary, ["models"]);
  } catch {
    return { models: null, loginState: "unknown" };
  }
  const combined = `${out.stdout}\n${out.stderr}`;
  if (out.status === 0) {
    const models = parseAgyModels(out.stdout);
    // 成功但没有可解析的模型行 ⇒ 不报清单；登录态仍可判为已登录（命令本身跑通了）
    return { models, loginState: "logged_in" };
  }
  if (NEEDS_LOGIN_RE.test(combined)) return { models: null, loginState: "needs_login" };
  return { models: null, loginState: "unknown" };
}

export interface AgyCatalogCache {
  /** 同步读最近一次探测结果；**从不阻塞**心跳。未探测过 ⇒ unknown、不报模型。 */
  current(now?: number): AgyProbeResult;
  /** 后台刷新（带 single-flight）；失败不影响已有结果。 */
  refresh(now?: number): Promise<AgyProbeResult>;
}

export function createAgyCatalogCache(deps: AgyProbeDeps, ttlMs = 10 * 60_000): AgyCatalogCache {
  let last: AgyProbeResult = { models: null, loginState: "unknown" };
  let lastAt = 0;
  let inflight: Promise<AgyProbeResult> | null = null;
  return {
    current(now = Date.now()) {
      if (lastAt && now - lastAt <= ttlMs) return last;
      return last; // 过期也先给旧值：心跳只能读，不能等
    },
    async refresh(now = Date.now()) {
      if (inflight) return inflight;
      if (lastAt && now - lastAt <= ttlMs) return last;
      // inflight 必须在 promise **外面**清除：写在 async 体内的 finally 会被下面的赋值
      // 立刻覆盖回一个已完成的 promise，导致之后再也不探测（实测踩到过）。
      const job = (async () => {
        try {
          last = probeAgy(deps);
          lastAt = now;
        } catch {
          // 探测异常：保留旧值（可能是 unknown），绝不让心跳失败
        }
        return last;
      })();
      inflight = job;
      void job.finally(() => { if (inflight === job) inflight = null; });
      return job;
    },
  };
}
