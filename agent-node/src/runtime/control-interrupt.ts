// control-interrupt —— 「停止当前轮」的节点侧实现（#cancel）。
//
// 事实基础（2026-11-11 实测，OpenCode V2 server 2.0.22）：
//   POST /api/session/<ses_id>/interrupt → 200 {"interrupted": true|false}
//   （abort / cancel / stop / turn.abort 全 404 —— 唯一入口就是 interrupt）
//
// 为什么单独一个模块：这条路径要能被单测覆盖「在飞 / 不在飞 / 端点缺失 / 网络错」
// 四种结果，而不是埋在 cli.ts 的分派里靠日志判断。

export type InterruptOutcome =
  | { ok: true; interrupted: true }
  | { ok: true; interrupted: false }
  | { ok: false; reason: "no_endpoint" | "no_session" | "http_error" | "bad_response"; detail?: string };

export interface InterruptDeps {
  /** 读当前节点的 OpenCode 端点（url + authorization）。读不到返回 null。 */
  readEndpoint: () => { url: string; authorization: string } | null;
  /** 当前 copresence 会话 id；没有会话时为 null。 */
  sessionId: () => string | null;
  /** 注入 fetch 便于测试；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export async function interruptCurrentTurn(deps: InterruptDeps): Promise<InterruptOutcome> {
  const ep = deps.readEndpoint();
  if (!ep?.url || !ep.authorization) return { ok: false, reason: "no_endpoint" };
  const sid = deps.sessionId();
  if (!sid) return { ok: false, reason: "no_session" };
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`${ep.url}/api/session/${encodeURIComponent(sid)}/interrupt`, {
      method: "POST",
      headers: { authorization: ep.authorization, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, reason: "http_error", detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { interrupted?: unknown } | null;
    if (!body || typeof body !== "object") return { ok: false, reason: "bad_response" };
    return body.interrupted === true ? { ok: true, interrupted: true } : { ok: true, interrupted: false };
  } catch (e: any) {
    return { ok: false, reason: "http_error", detail: e?.message ?? String(e) };
  }
}

/**
 * The shared OpenCode Server this node is configured for, as an interrupt endpoint.
 *
 * The usual source is the catalog endpoint record the node writes at startup. That record holds a
 * copy of the Server password and is not written on Windows (#3812) — so a stop sent to a Windows
 * node answered `no_endpoint` and the turn kept running (measured on a real machine). The node's
 * own configuration already names the Server and its password file; read it from there.
 * `readPassword` must refuse a password file that is not private. Anything missing or refused
 * yields null: the caller reports no endpoint, it does not guess one.
 */
export function sharedServerInterruptEndpoint(
  config: { opencodeSharedServerUrl?: unknown; opencodeSharedServerPasswordFile?: unknown } | null | undefined,
  readPassword: (passwordFile: string) => string,
): { url: string; authorization: string } | null {
  const url = config?.opencodeSharedServerUrl, file = config?.opencodeSharedServerPasswordFile;
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || typeof file !== "string" || !file) return null;
  let password: string;
  try { password = readPassword(file).trim(); } catch { return null; }
  if (!password) return null;
  return { url, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

/** 控制消息的载荷形状：{op:"interrupt"}。解析失败不猜，返回 null。 */
export function parseControlOp(content: unknown): "interrupt" | null {
  if (typeof content !== "string") return null;
  try {
    const j = JSON.parse(content);
    return j && typeof j === "object" && j.op === "interrupt" ? "interrupt" : null;
  } catch {
    return null;
  }
}
