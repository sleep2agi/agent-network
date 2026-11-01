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
