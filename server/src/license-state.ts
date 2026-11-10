// 2026-10-31 —— `license` 字段的三值化。
//
// 现状：`/health` 只给 `license: license?.type || "none"`。
// 而 "none" 同时覆盖三种不同的事：
//    · 查询成功、确实没有 license 行      → 去授权能修
//    · 查询成功、有行但 type 为空/缺失    → 数据不全，补行能修
//    · 查询失败                          → 补一次取数能修
//
// ⇒ 三种的**修法不同**，却共用一个字符串。这正是那条：
//   「空值折叠的方向，总是朝着『让你继续往下走』」—— 这里的方向是「当成没有授权」。
//
// 🔴 absent 与 unknown 的区别是**谁能修**：
//      absent  = 我们知道它不在（改配置/去授权）
//      unknown = 没人去看 / 看失败了（补一次取数）
//    混成一个值之后，修法也一起混了。
//
// 兼容：`license` 字段保留一个版本（语义不精确，勿用于判据），
//       判据请用 `license_state`。等外部读者迁移完再下线旧字段。

export type LicenseState =
  | { kind: "known"; type: string }
  | { kind: "absent" }
  | { kind: "unknown"; reason: "license_query_failed" | "license_row_without_type" };

export interface LicenseRow {
  type?: unknown;
  expires_at?: unknown;
}

/**
 * 纯函数：把「一次查询的结果」映射成三态。
 *
 * @param row     查询到的行；null/undefined 表示查询成功但没有行
 * @param failed  查询是否抛错（抛错时 row 无意义）
 */
export function licenseStateOf(row: LicenseRow | null | undefined, failed = false): LicenseState {
  if (failed) return { kind: "unknown", reason: "license_query_failed" };
  if (!row) return { kind: "absent" };
  const type = typeof row.type === "string" ? row.type.trim() : "";
  if (!type) return { kind: "unknown", reason: "license_row_without_type" };
  return { kind: "known", type };
}

/** 兼容字段的渲染（保持与旧行为逐字相同，便于逐步下线）。 */
export function legacyLicenseField(row: LicenseRow | null | undefined): string {
  const type = row && typeof row.type === "string" ? row.type : "";
  return type || "none";
}
