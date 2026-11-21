// #4821 —— daemon 侧：把 Hub 上排队的「列会话」请求拉下来，读本地 OpenCode V2，回填。
//
// 契约（Hub 侧 opencode-session-requests.ts）：
//   · 我们回填的是 **OpenCode 原始页** {data:[...], cursor}，投影在 Hub 做一次；
//   · ok=false 必须带 error，且不要把「读不到」装成「空列表」；
//   · ack 是幂等的，重复 ack 不会改变终态。
//
// 为什么放在 daemon（而不是让 Hub 直连）：daemon 在 NAT 后面，只有它能反向调用 Hub。
// 与 scoped-secrets 同一形状：可重入、失败只警告不抛、不阻塞主循环。
import { fetchOpenCodeSessionPage } from "./opencode-copresence/sessions.js";

export type SessionBridgeDeps = {
  callCommHub: (name: string, args: Record<string, unknown>) => Promise<any>;
  /** 读一页原始会话；失败要抛出（不要返回空页）。 */
  readPage: (opts: { cursor: string | null; limit: number }) => Promise<unknown>;
  /** 并发去重用的 key（通常是 networkId + daemonId）。 */
  key: string;
  warn: (text: string) => void;
};

const inFlight = new Map<string, Promise<void>>();

/** 一次 drain：拉到几条处理几条，处理完退出（调用方决定频率）。 */
export async function drainSessionRequests(deps: SessionBridgeDeps, limit = 5): Promise<void> {
  const pull: any = await deps.callCommHub("pull_session_requests", { limit });
  if (!pull?.ok || !Array.isArray(pull.requests)) return;
  for (const req of pull.requests) {
    const requestId = typeof req?.request_id === "string" ? req.request_id : "";
    if (!requestId) continue;
    const cursor = typeof req.cursor === "string" && req.cursor ? req.cursor : null;
    const lim = Number.isInteger(req.limit) && req.limit > 0 ? Math.min(req.limit, 100) : 50;
    try {
      const page = await deps.readPage({ cursor, limit: lim });
      await deps.callCommHub("ack_session_request", { request_id: requestId, ok: true, data_json: JSON.stringify(page) });
    } catch (error: any) {
      await deps.callCommHub("ack_session_request", { request_id: requestId, ok: false, error: "opencode_unreachable" })
        .catch(() => deps.warn(`[opencode-sessions] ack failed for ${requestId}`));
      deps.warn(`[opencode-sessions] read failed (${error?.message ?? error})`);
    }
  }
}

/** 可重入包装：已有 drain 在跑就不叠加（门铃 + 轮询可能同时到）。 */
export function scheduleSessionRequestDrain(deps: SessionBridgeDeps, limit = 5): Promise<void> {
  const running = inFlight.get(deps.key);
  if (running) return running;
  const promise = drainSessionRequests(deps, limit)
    .catch((error: any) => deps.warn(`[opencode-sessions] drain failed: ${error?.message ?? error}`))
    .finally(() => inFlight.delete(deps.key));
  inFlight.set(deps.key, promise);
  return promise;
}

const loops = new Set<string>();

/** 周期 drain（幂等：同一 key 只挂一个定时器）。门铃不可靠时靠它兜底。 */
export function startSessionRequestDrainLoop(deps: SessionBridgeDeps, intervalMs = 15_000): void {
  if (loops.has(deps.key)) return;
  loops.add(deps.key);
  const timer = setInterval(() => { void scheduleSessionRequestDrain(deps); }, intervalMs);
  (timer as any).unref?.();
}

/** 把 fileConfig 里的共享 server 配置变成 readPage；没有共享 server 就是 null（不猜）。 */
export function makeSharedServerPageReader(args: {
  url: string | undefined;
  passwordFile: string | undefined;
  readFile: (path: string) => string;
}): ((opts: { cursor: string | null; limit: number }) => Promise<unknown>) | null {
  const { url, passwordFile } = args;
  if (!url || !passwordFile) return null;
  return async (opts) => {
    const password = args.readFile(passwordFile).trim();
    if (!password) throw new Error("opencode_password_missing");
    return fetchOpenCodeSessionPage(url, password, { cursor: opts.cursor, limit: opts.limit });
  };
}
