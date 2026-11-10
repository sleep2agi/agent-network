/**
 * #3294 —— 构建期注入的构建标识（CLI 这一半）。
 *
 * 与 `server/src/build-info.ts` 同一套三态语义（present / absent / invalid），
 * 但**不能跨包 import**（agent-network 与 commhub-server 分别发布，跨包相对路径在发布后会断）。
 * 所以这里是一份独立实现；两份必须保持同样的判据：
 *   present —— 读到且通过严格校验
 *   absent  —— 文件不存在（源码检出 / 老制品）⇒ **正常**
 *   invalid —— 文件在但形状不对 ⇒ **缺陷**，不能与 absent 同形
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = {
  schema: 1;
  commit: string;
  dirty: boolean;
  built_at: string;
  source?: string;
};

export const BUILD_INFO_FILE = "build-info.json";
const SHA40 = /^[0-9a-f]{40}$/;

function isIsoUtc(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 20) return false;
  return Number.isFinite(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

export function validateBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1) return null;
  if (typeof o.commit !== "string" || !SHA40.test(o.commit)) return null;
  if (typeof o.dirty !== "boolean") return null;
  if (!isIsoUtc(o.built_at)) return null;
  if (o.source !== undefined && typeof o.source !== "string") return null;
  const out: BuildInfo = { schema: 1, commit: o.commit, dirty: o.dirty, built_at: o.built_at };
  if (typeof o.source === "string") out.source = o.source;
  return out;
}

export type BuildInfoRead =
  | { kind: "present"; info: BuildInfo }
  | { kind: "absent" }
  | { kind: "invalid"; error: string };

export function readBuildInfo(dir: string): BuildInfoRead {
  const path = join(dir, BUILD_INFO_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { kind: "absent" };
    return { kind: "invalid", error: `unreadable:${e?.code ?? "unknown"}` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { kind: "invalid", error: "invalid_json" }; }
  const info = validateBuildInfo(parsed);
  return info ? { kind: "present", info } : { kind: "invalid", error: "invalid_shape" };
}

/**
 * 从**这个模块所在包**读 build-info。`bin/cli.ts` 与 `dist/bin/cli.js` 的层级不同，
 * 所以向上找不超过 3 层，命中即返回；找不到返回 absent。
 */
export function readPackageBuildInfo(): BuildInfoRead {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i += 1) {
    const r = readBuildInfo(dir);
    if (r.kind !== "absent") return r;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "absent" };
}

/** `anet --version` 里那一行的文本：三个状态各有各的说法，绝不把「没有」显示成「没问题」。 */
export function formatBuildLine(r: BuildInfoRead): string {
  if (r.kind === "present") {
    return `build ${r.info.commit.slice(0, 12)}${r.info.dirty ? " (dirty tree — quote as self-reported only)" : ""}`;
  }
  if (r.kind === "invalid") {
    return `build unknown (build-info.json is present but invalid: ${r.error})`;
  }
  return "build unknown (this install has no build-info.json)";
}
