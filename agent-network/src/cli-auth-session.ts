// `anet logout` / `anet init` / `anet login --hub` 换 Hub 时的「服务端撤销 + 本地清理」(#513,#502 审计)。
//
// 之前 `anet logout` 只删 ~/.anet/config.json 里的 token,Hub 上那条登录会话仍然有效
// (登录会话令牌闲置 30 天才过期,`COMMHUB_SESSION_IDLE_DAYS=0` 时永不过期)。
// 而 `anet init --hub <另一个 Hub>` 只改 hub 字段,旧 Hub 的 token 留在配置里,
// 之后每条命令都会把它发给新 Hub。
//
// 撤销走 app「设置 → 账号 → 登录设备 → 退出」用的同一对端点(#2114,Hub .70 起):
//   GET    /api/auth/sessions               → current_token_id(本次调用所用令牌的 id)
//   DELETE /api/auth/sessions/:token_id     → 撤销那一条登录会话(撤当前这条 = 退出登录)
// 只撤**登录会话**:`anet login --token` 塞进来的显式 API 令牌(scope=full)、节点令牌
// 由各自的入口撤销(见 docs-site/docs/api/rest.md#sessions),DELETE 对它们回
// 404 session_not_found —— 那时我们告诉用户它仍有效,而不是替他删一个可能还在别处用的令牌。
//
// 🔴 任何输出都不含 token 本身;只出现 token_id(tok_…,不是凭据)。

export type RevokeOutcome =
  /** 服务端已撤销 */
  | { kind: "revoked"; tokenId: string }
  /** Hub 回 401:这个 token 在服务端本来就无效了(过期/已撤/改过密码),没东西可撤 */
  | { kind: "already_invalid" }
  /** 不是登录会话(显式 API 令牌 / 节点令牌):按设计不撤,仍有效 */
  | { kind: "not_a_session"; tokenId?: string }
  /** Hub 没有 /api/auth/sessions(早于 #2114 的旧版本 → 404) */
  | { kind: "unsupported"; status: number }
  /** 连不上 Hub(DNS / 拒绝连接 / 超时) */
  | { kind: "unreachable"; error: string }
  /** 其他意外响应 */
  | { kind: "failed"; status?: number; error: string };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function normalizeHubUrl(url: string): string {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export function sameHub(a?: string | null, b?: string | null): boolean {
  return normalizeHubUrl(a ?? "") === normalizeHubUrl(b ?? "");
}

/** 本地登录态字段。hub 不在里面:退出登录不等于忘掉 Hub 地址。 */
export const LOCAL_CREDENTIAL_KEYS = ["token", "user", "network_id", "network_name"] as const;

export function clearLocalCredentials(gc: Record<string, any>): Record<string, any> {
  for (const k of LOCAL_CREDENTIAL_KEYS) delete gc[k];
  return gc;
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

function errMessage(e: unknown): string {
  const any = e as any;
  const code = any?.code || any?.cause?.code;
  const msg = any?.name === "TimeoutError" ? "timed out" : String(any?.message ?? e);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

/** 在 `hub` 上撤销 `token` 所代表的登录会话。只把 token 发给 `hub` 本身。 */
export async function revokeCurrentLoginSession(
  hub: string,
  token: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<RevokeOutcome> {
  const f: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const base = normalizeHubUrl(hub);
  const headers = { Authorization: `Bearer ${token}` };

  let listed: Response;
  try {
    listed = await f(`${base}/api/auth/sessions`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { kind: "unreachable", error: errMessage(e) };
  }
  const listBody = await readJson(listed);
  if (listed.status === 401) return { kind: "already_invalid" };
  if (listed.status === 403) return { kind: "not_a_session" }; // user_token_required:节点令牌
  if (listed.status === 404 || listed.status === 405) return { kind: "unsupported", status: listed.status };
  if (!listed.ok || !listBody?.ok) {
    return { kind: "failed", status: listed.status, error: String(listBody?.error ?? `HTTP ${listed.status}`) };
  }
  const tokenId = typeof listBody.current_token_id === "string" ? listBody.current_token_id : "";
  if (!tokenId) return { kind: "failed", status: listed.status, error: "hub did not report current_token_id" };

  let del: Response;
  try {
    del = await f(`${base}/api/auth/sessions/${encodeURIComponent(tokenId)}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { kind: "unreachable", error: errMessage(e) };
  }
  const delBody = await readJson(del);
  if (del.ok && delBody?.ok) return { kind: "revoked", tokenId };
  if (del.status === 401) return { kind: "already_invalid" };
  if (del.status === 404 && delBody?.error === "session_not_found") return { kind: "not_a_session", tokenId };
  if (del.status === 404 || del.status === 405) return { kind: "unsupported", status: del.status };
  return { kind: "failed", status: del.status, error: String(delBody?.error ?? `HTTP ${del.status}`) };
}

const HOW_TO_REVOKE =
  "Revoke it yourself: app → 设置 → 账号 → 登录设备 (Settings → Account → Signed-in devices) → sign that device out, " +
  "or change your password (`anet login` then `anet passwd` signs out every other login session).";

/** 把撤销结果翻成给人看的行。`ok=false` 表示服务端令牌**仍然有效**,调用方按警告打印。 */
export function describeRevokeOutcome(o: RevokeOutcome, hub: string): { ok: boolean; lines: string[] } {
  const h = normalizeHubUrl(hub);
  switch (o.kind) {
    case "revoked":
      return { ok: true, lines: [`Revoked the login session on ${h} (token id ${o.tokenId}).`] };
    case "already_invalid":
      return { ok: true, lines: [`The saved token was already invalid on ${h} (expired or revoked); nothing to revoke.`] };
    case "not_a_session":
      return { ok: false, lines: [
        `⚠ The saved token is not a login session on ${h} (an API token or node token${o.tokenId ? `, id ${o.tokenId}` : ""}); it was NOT revoked and is STILL VALID on the Hub.`,
        `  Revoke API tokens with: anet token ls / anet token revoke <token_id> (or in the app).`,
      ] };
    case "unsupported":
      return { ok: false, lines: [
        `⚠ ${h} does not support session revocation (HTTP ${o.status} on /api/auth/sessions — Hub older than v0.9.0-preview.70).`,
        `  The token was removed locally but is STILL VALID on the Hub. ${HOW_TO_REVOKE}`,
      ] };
    case "unreachable":
      return { ok: false, lines: [
        `⚠ Could not reach ${h} to revoke the token (${o.error}).`,
        `  The token was removed locally but is STILL VALID on the Hub. ${HOW_TO_REVOKE}`,
      ] };
    case "failed":
      return { ok: false, lines: [
        `⚠ ${h} refused to revoke the token (${o.status ? `HTTP ${o.status}: ` : ""}${o.error}).`,
        `  The token was removed locally but may STILL BE VALID on the Hub. ${HOW_TO_REVOKE}`,
      ] };
  }
}
