// #1645 —— codex-sdk 节点 resume 长线程时一天 17 次「300s 超时」,日志里的真因之一是
// `unknown variant \`max\`, expected one of none/minimal/low/medium/high/xhigh`:
// 上游 models 响应带了本机 codex 不认识的推理档位,codex 的 models cache 解不动,
// rmcp worker 致命退出,一整轮走不下去。这里在起线程之前读同一份缓存文件,
// 把「本机 codex 认不认得上游给的档位」变成一条启动时就能看见的警告。
// 只读、只警告、不阻断:缓存不存在 / 不是 JSON / 形状不认识 都当「没证据」。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReasoningEffort } from "../types/codex/ReasoningEffort.js";
import { compareCodexVersions } from "./codex-bin.js";

/** 与 types/codex/ReasoningEffort.ts 的联合类型逐项对应(测试钉住)。 */
export const KNOWN_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ReasoningEffort[];

export function codexModelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : join(homedir(), ".codex");
  return join(home, "models_cache.json");
}

const EFFORT_KEY = /effort|reasoning_level/i;

/** 收集缓存里所有「推理档位」字符串:键名含 effort / reasoning_level 的字符串、字符串数组、或对象里的 effort 字段。 */
export function collectReasoningEffortsFromModelsCache(cache: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, keyHint: string): void => {
    if (typeof value === "string") {
      if (EFFORT_KEY.test(keyHint)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        // `{ effort: "max", ... }` 这种对象:effort 字段是档位;其它字段继续往下走,
        // 但不把父级键名当作 effort 提示传下去(避免把 description 之类的字符串当成档位)。
        visit(inner, key);
      }
    }
  };
  visit(cache, "");
  return [...found].sort();
}

export interface UnknownReasoningEffortReport {
  unknown: string[];
  clientVersion: string | null;
}

export function findUnknownReasoningEfforts(
  cache: unknown,
  known: readonly string[] = KNOWN_REASONING_EFFORTS,
): UnknownReasoningEffortReport {
  const efforts = collectReasoningEffortsFromModelsCache(cache);
  const unknown = efforts.filter((effort) => !known.includes(effort));
  const clientVersion = cache && typeof cache === "object" && typeof (cache as { client_version?: unknown }).client_version === "string"
    ? (cache as { client_version: string }).client_version
    : null;
  return { unknown, clientVersion };
}

/**
 * 读文件 + 判断;任何读/解析失败都返回 [](没证据 ≠ 没问题,但也不能把节点吓停)。
 *
 * #1973 —— `KNOWN_REASONING_EFFORTS` 是 codex 0.133(内置)那一代的集合。#1969 之后节点
 * 可能跑更新的 codex(`selectedCodexVersion`,来自 codex-bin.ts 的解析结果)。规则:
 * - 选中的 codex 版本已知且 ≥ 缓存写入者(`client_version`)⇒ 它认得自己写下的档位,不警告;
 * - 选中的版本比写入者旧 ⇒ 照旧警告,并写明两个版本;
 * - 任一版本未知 ⇒ 退回硬编码集合的老判断。
 */
export function describeUnknownReasoningEfforts(
  path: string = codexModelsCachePath(),
  selectedCodexVersion?: string,
): string[] {
  let cache: unknown;
  try {
    cache = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const report = findUnknownReasoningEfforts(cache);
  if (report.unknown.length === 0) return [];
  const selected = selectedCodexVersion && selectedCodexVersion.trim() ? selectedCodexVersion.trim() : null;
  if (selected && report.clientVersion && compareCodexVersions(selected, report.clientVersion) >= 0) return [];
  const olderThanWriter = !!(selected && report.clientVersion);
  const who = olderThanWriter
    ? `本机选中的 codex ${selected} 比写缓存的 codex ${report.clientVersion} 旧,可能不认识`
    : `本机 codex 可能不认识(只按内置集合 ${KNOWN_REASONING_EFFORTS.join("/")} 判断${report.clientVersion ? `;缓存由 codex ${report.clientVersion} 写下` : ""}${selected ? "" : ";选中的 codex 版本未知"})`;
  return [
    `[codex] 上游 models 缓存里有推理档位: ${report.unknown.join(", ")} —— ${who}。`,
    `[codex] 若确实不认识,resume 线程时 codex 会以 \`unknown variant\` 致命退出,表现为 300s 超时(#1645)。升级 codex-cli 后重启节点;缓存文件: ${path}`,
  ];
}
