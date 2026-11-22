// #5123 —— OpenCode V2 思考档位持久化。
//
// 现状（改前）：档位是**会话级**的 —— 切换走 config patch → applyVariantConfig 热切，
// 但 cli.ts 的注释明确写着「live-session-only：never enter ... config-file writeback paths」，
// 所以重启或新会话就回到上游默认。
//
// 本模块只做两件纯事（便于单测），副作用由调用方注入：
//   ① 写回：只在回读确认 applied 之后落盘（rejected / unknown 一律不写 ——
//      unknown 落盘会制造「配置说切了、会话没切」的谎，比不持久化更坏）
//   ② 启动恢复计划：configured（配置里想要的档位）vs current（会话当前档位）
//      → apply / noop / skip-unsupported
//
// 语义边界（写进 #5123 方案）：档位提升为**节点配置级**（与 model 同级）；
//   多人共用一个 OpenCode server 时是「最后一写者生效」；旧节点忽略该键 ⇒ 降级为会话级，不报错。
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export type VariantSwitchStatus = "applied" | "rejected" | "unknown";

/** 档位字符串的合法形状（与 v2-session 的写入校验同一条，别放宽）。 */
export function isValidVariantId(variant: unknown): variant is string {
  return typeof variant === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(variant);
}

/** 只有回读确认 applied 才允许写回。`default` 表示「显式回到默认档」。 */
export function shouldPersistVariant(status: VariantSwitchStatus, variant: string | null | undefined): boolean {
  if (status !== "applied") return false;
  if (variant === null) return true;             // 显式清空（回到默认档）
  return isValidVariantId(variant);
}

export type StartupVariantPlan = "apply" | "noop" | "skip-unsupported";

/**
 * 启动恢复判据。`current` 为会话当前档位（"default" / undefined 视为未设置）。
 * 只决定「要不要尝试」，不改变任何状态 —— 应用本身由调用方 best-effort 做。
 */
export function startupVariantPlan(
  configured: string | null | undefined,
  current: string | null | undefined,
  capable: boolean,
): StartupVariantPlan {
  if (!capable) return "skip-unsupported";
  if (!configured) return "noop";
  if (!isValidVariantId(configured)) return "noop";       // 配置里有脏值：不动会话，也别去清
  const cur = current === undefined || current === null || current === "default" ? null : current;
  return cur === configured ? "noop" : "apply";
}

export interface PersistVariantDeps {
  readConfig: (path: string) => string;
  writeConfig: (path: string, content: string) => void;
  rename: (from: string, to: string) => void;
  warn: (message: string) => void;
}

/** 原子写回 config.json 的 modelVariant。失败只 warn，不影响切换结果本身。 */
export function persistVariantToConfig(
  configPath: string | null | undefined,
  variant: string | null,
  deps: Partial<PersistVariantDeps> = {},
): boolean {
  if (!configPath) return false;
  const readConfig = deps.readConfig ?? ((p: string) => readFileSync(p, "utf-8"));
  const writeConfig = deps.writeConfig ?? ((p: string, c: string) => writeFileSync(p, c, { mode: 0o600 }));
  const rename = deps.rename ?? ((from: string, to: string) => renameSync(from, to));
  const warn = deps.warn ?? (() => {});
  // 纵深防御：调用方可能漏过 shouldPersistVariant；这里再挡一次形状，
  // 避免把一个永远用不上的脏值写进 config.json（#5123 review 2026-11-22）。
  if (variant !== null && !isValidVariantId(variant)) {
    warn(`[variant-persist] refused invalid variant id (${String(variant).slice(0, 40)})`);
    return false;
  }
  try {
    const cfg = JSON.parse(readConfig(configPath));
    if (variant === null) delete cfg.modelVariant;
    else cfg.modelVariant = variant;
    const tmp = `${configPath}.variant-${process.pid}.tmp`;
    writeConfig(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    rename(tmp, configPath);
    return true;
  } catch (error: any) {
    warn(`[variant-persist] writeback failed: ${error?.message ?? error}`);
    return false;
  }
}
