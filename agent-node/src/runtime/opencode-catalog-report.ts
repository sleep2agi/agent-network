// #3144 —— 快照 → 心跳里那一格。抽成独立纯函数，因为它有两条**必须被单独钉住**的规则：
//
//  ① 没有模型就没有清单。空数组不报，避免客户端把「空清单」读成「这个节点支持 0 个模型」
//     —— 那是三个不同结论（没采到 / 采到了但为空 / 真的不支持），不能塌成一个。
//  ② 采到模型但**没有采集时刻**时不编一个。编出来的时刻会把「不知道多旧」显示成「刚刚」，
//     比不显示更坏；此时上报 seenAt 为空串，调用方据此省略该键（Hub 侧读到的是 null）。
//
// 为什么不放在 cli.ts 里：cli.ts 是入口，import 它会跑起整个进程，单测拿不到干净的调用点。

export interface CatalogSnapshotLike {
  models: Array<{ providerId: string; id: string }>;
  observedAt?: string | null;
}

export interface CatalogReport {
  models: string[];
  /** 空串 = 「采到了模型，但上游没给采集时刻」。Hub 侧见 null，不塌成「刚刚」。 */
  seenAt: string;
}

export function catalogReport(snapshot: CatalogSnapshotLike): CatalogReport | undefined {
  // provider/model 形式与 Hub 侧的 model 引用同构（#3143）；只带 id，不带名字/headers/endpoint。
  const models = snapshot.models.map((m) => `${m.providerId}/${m.id}`).slice(0, 400);
  if (!models.length) return undefined;
  const raw = typeof snapshot.observedAt === "string" ? snapshot.observedAt.trim() : "";
  // Hub 侧那一列是 max(40) 的字符串；这里先截，避免整份心跳因一格超长被拒。
  return { models, seenAt: raw.slice(0, 40) };
}

// ── 缓存：一次读失败不许把整份清单抹掉 ──
//
// 生产实测（2026-11-01，通信欧 n_28e6b2c2）：节点**正在干活**时，
// /api/provider + /api/model + /api/model/default 三次读要抢同一个 busy 的
// opencode server，3 秒超时经常不够 ⇒ reportedOpenCodeCatalog 返回 undefined
// ⇒ 这一次心跳的 config_snapshot 里**没有** opencode_catalog（快照是整份覆盖写的，
// 不是逐键合并）⇒ 客户端看到的是「这个节点没有清单」，于是回落到「同 runtime 其他节点」
// 的清单 —— 用户点到本机其实也有、但来源不同的模型，切换失败时分不清是哪种原因。
//
// 规则：读失败就沿用**上一次成功**的那份，并保留它的 seenAt。
// seenAt 保留是对的：它说的就是「这份清单是什么时候采的」，不是「这次心跳的时间」。
export function keepLastCatalog(
  previous: CatalogReport | undefined,
  next: CatalogReport | undefined,
): CatalogReport | undefined {
  return next ?? previous;
}
