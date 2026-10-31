/**
 * 2026-10-31 —— **构建期注入的构建标识**（#3177）。
 *
 * 为什么需要它：`detectBootGitIdentity()` 是**运行期** `git rev-parse` 从 module_dir 向上找 `.git`。
 * 而生产的部署形态是 `npm install --prefix ~/.commhub/runtime-…` 的产物 —— **没有 .git**。
 * 实测（部署 .246 之后）：`/health` 的 `build_identified = false`。
 * ⇒ 同一版本号、不同字节，在生产上**无法分辨**；而 runtime 读 git 这条路在部署形态上不存在。
 *
 * 所以标识必须由**构建时**写下来，运行期只负责读，并且**读不到要能与「没有标识」区分**。
 *
 * 本模块只做读取与**严格校验**：形状不对就返回 null，绝不猜、绝不抛。
 * 判据：一个坏掉的 build-info.json 与「没有这个文件」是两件事，
 * 但两者都不能变成「看起来有标识」—— 所以校验失败一律 null，由调用方的 reason 去说明。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type BuildInfo = {
  schema: 1;
  /** 40 位小写十六进制；构建时的 HEAD。 */
  commit: string;
  /** 构建时工作树是否脏。脏的 commit 只能当「自称」用。 */
  dirty: boolean;
  /** 构建时刻（ISO 8601，UTC）。 */
  built_at: string;
  /** 可选：谁写的（例如 "release.yml"）。仅用于人读。 */
  source?: string;
};

export const BUILD_INFO_FILE = "build-info.json";

const SHA40 = /^[0-9a-f]{40}$/;

function isIsoUtc(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 20) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}

/** 校验一份 build-info 载荷；形状不对返回 null（不抛）。 */
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

/**
 * 从某个目录读 build-info.json。
 *
 * 返回**两态**而不是一态：
 *   `{ kind: "present", info }`  —— 读到且通过校验
 *   `{ kind: "absent" }`         —— 文件不存在（部署形态没注入）
 *   `{ kind: "invalid", error }` —— 文件在但形状不对（这是**缺陷**，不是「没有」）
 * 第三种必须与第二种分开：否则「注入写坏了」会读成「还没注入」，而后者是正常状态。
 */
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
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", error: "invalid_json" };
  }
  const info = validateBuildInfo(parsed);
  return info ? { kind: "present", info } : { kind: "invalid", error: "invalid_shape" };
}
