// #4987 —— 只读收件箱端点的三个可单测判定（从 server.ts 抽出，避免把逻辑埋在路由里）。
//
// 为什么抽出来：这三个判定都曾出过错，而且**错的时候不会抛异常**，只会给出错误内容：
//   · `scope` 用 alias 互相比较 ⇒ owner 分支下恒等 ⇒ 代读被静默标成 self；
//   · `at` 直接透传 SQLite 的 'YYYY-MM-DD HH:MM:SS' ⇒ 前端当成本地时间；
//   · 跨网络 owner 读别的网络的同名 alias ⇒ 直接读到别人的收件箱。

/** SQLite datetime → ISO-8601 UTC（带 Z）。不是这种形状就原样返回，不猜。 */
export function inboxAtIsoUtc(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : (value ?? "");
}

/** scope 只取决于「调用者身份是否等于收件节点」，不比较 alias 字符串。 */
export function inboxScope(delegated: boolean): "self" | "delegated" {
  return delegated ? "delegated" : "self";
}

/**
 * 跨网络拒绝：用户令牌代读时，目标 alias 必须**在调用方自己的网络里存在**。
 * `inNetwork` 由调用方查库得出（避免这里依赖 db）。
 */
export function inboxCrossNetworkRejected(input: { callerNetworkId: string | null; delegated: boolean; inNetwork: boolean }): boolean {
  if (!input.callerNetworkId) return false;   // 全局令牌：由 network_id_required 拦，不在这里判
  if (!input.delegated) return false;         // 读自己：不涉及跨网络
  return !input.inNetwork;
}

/**
 * 代读时不能带出「无网络」的旧行（review 第 3 条）。
 * 读自己时保留 `network_id IS NULL`（老数据没写 network_id，仍是本节点自己的）；
 * owner 代读是替别人看，混进无网络行会给出不属于该网络的收件箱。
 */
export function inboxNetworkFilter(delegated: boolean): string {
  return delegated ? "network_id = ?2" : "(network_id IS NULL OR network_id = ?2)";
}
