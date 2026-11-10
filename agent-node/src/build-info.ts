/**
 * #3294 —— agent-node 侧的构建标识（读侧）。
 *
 * 与 `server/src/build-info.ts`、`agent-network/src/build-info.ts` **同一套判据**（present/absent/invalid），
 * 但三份是各自独立的实现：这三个包分别发布，跨包相对 import 在发布后会断。
 *
 * 为什么要读而不是编译期内联：`bun build` 内联 package.json 只给「版本标签」；
 * 「哪一份字节」必须由**打包时写下的文件**告诉运行时 —— 而 npm 安装树里没有 .git，
 * 运行期读 git 这条路在那里根本不存在。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = { schema: 1; commit: string; dirty: boolean; built_at: string; source?: string };
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

export type BuildInfoRead = { kind: "present"; info: BuildInfo } | { kind: "absent" } | { kind: "invalid"; error: string };

export function readBuildInfo(dir: string): BuildInfoRead {
  let text: string;
  try {
    text = readFileSync(join(dir, BUILD_INFO_FILE), "utf8");
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
 * 从本模块向上找 build-info.json（`dist/` 与 `src/` 的层级不同，最多 3 层）。
 *
 * **只返回 commit**，且 absent/invalid 都返回 undefined —— 因为给它找话说的地方在 Hub
 * （/api/nodes 的 `build_note`）。节点这边不重复造一套措辞。
 */
export function buildCommitOfThisInstall(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i += 1) {
    const r = readBuildInfo(dir);
    if (r.kind === "present") return r.info.commit;
    if (r.kind === "invalid") return undefined;   // 坏掉 ≠ 没有，但这一层只说值；成因由 Hub 的 note 承担
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
