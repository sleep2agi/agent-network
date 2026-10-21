// #1974 —— 「alias 不在请求的网络里」时,发到调用者**另一个**网络里那个 alias 所在的网络。
//
// 起因(admin 2026-10-21 截图 + hub 拒绝日志):
//   [15:55:54] tang → /api/task → tang02: REJECTED 404 alias_not_found (net=net_ac567b4ab74e)
//
// 客户端的 Agent 列表是**跨网络**的:`GET /api/status?light=1` 不带 network_id,
// hub 就按「调用者属于哪些网络」返回。tang 因此同时看到默认网络(net_399bdf86f528)的
// tang02/03/04 和自己个人网络(net_ac567b4ab74e)里的 Agent。发送却带着「登录时选定的
// 那一个网络」—— 多网络账号(自己网络的 owner + 团队网络的 admin)两个网络对它都是
// agent_access='all',pickDefaultNetworkId 于是选中了自己的个人网络 ⇒ 给团队网络的
// Agent 发消息一律 404 alias_not_found,客户端只显示「没有找到这个 Agent」+「未送达」。
//
// 客户端侧已有修法(用 alias 所在网络发),但那只在**新客户端**里生效;已经在用的旧客户端
// 仍然发不出去。这里补 Hub 侧:alias 唯一地存在于调用者的另一个网络、且调用者在那个网络
// 有写权限 ⇒ 就发到那儿去。旧客户端立刻受益,不用等升级。
//
// 三条红线:
//   ① 只在调用者**已加入**的网络里找(不跨租户、不做 alias 探测);
//   ② 同一个 alias 在调用者的多个网络里都存在 ⇒ **不猜**,保持 404;
//   ③ 调用者在目标网络没有写权限(受限成员没被授权这个 Agent)⇒ 保持 404/403。
//
// 纯函数:不碰 db、不碰 http,好测。

export interface AliasNetworkFallbackInput {
  /** 请求里带的 alias(已按请求网络 canonical 化)。 */
  alias: string;
  /** 请求带/推出的那个网络。 */
  requestedNetworkId: string | null;
  /** 调用者所属的全部网络。 */
  memberNetworkIds: readonly string[];
  /** 上面这些网络里,真的存在这个 alias 的网络(去重后)。 */
  networksWithAlias: readonly string[];
  /** 调用者在这个网络能不能写。 */
  canWrite: (networkId: string) => boolean;
  /** 调用者能不能给这个 alias 发消息(受限成员的 Agent 授权)。 */
  canMessage: (networkId: string) => boolean;
}

/**
 * 该发到哪个网络?返回 null = 保持原来的 404。
 *
 * 只在「请求的网络里没有这个 alias」时才会换网络;请求网络里有 ⇒ 传 requestedNetworkId
 * 之外一律不动(调用方只在 not_found 时才问这个函数)。
 */
export function pickAliasNetwork(input: AliasNetworkFallbackInput): string | null {
  const alias = (input.alias ?? '').trim();
  if (!alias) return null;
  const requested = (input.requestedNetworkId ?? '').trim();
  const members = new Set((input.memberNetworkIds ?? []).map(n => (n ?? '').trim()).filter(Boolean));
  if (members.size === 0) return null;

  // 请求的网络里本来就有这个 alias ⇒ 不换网络(它就在那儿,不用猜)。
  const withAlias = [...new Set((input.networksWithAlias ?? []).map(n => (n ?? '').trim()).filter(Boolean))];
  if (requested && withAlias.includes(requested)) return null;
  // 候选 = 调用者所属、且真的有这个 alias 的网络;请求网络本身不算。
  const candidates = withAlias.filter(n => n !== requested && members.has(n));
  if (candidates.length === 0) return null;
  // 多个网络都有同名 alias ⇒ 不猜(alias 探测的防线)。
  if (candidates.length > 1) return null;

  const only = candidates[0];
  if (!input.canWrite(only)) return null;
  if (!input.canMessage(only)) return null;
  return only;
}
