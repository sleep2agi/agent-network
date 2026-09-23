// #1615 —— grok CLI 会自我更新;更新到验证清单之外的版本后,**正在跑的节点表面正常,
// 下一次重启才起不来**,而 daemon 自动拉起 / anet daemon restart 这些自动化路径上没有
// 地方带 GROK_BINARY。
//
// 这里做的是「钉版」:节点启动并通过版本校验之后,把它**实际用的那个可执行文件的
// 绝对路径**和版本横幅写回自己的 config;之后再起时:
//   1. GROK_BINARY 环境变量(人显式指定)永远优先 —— 不改既有语义;
//   2. 否则用 config 里钉的绝对路径,前提是它还存在;
//   3. 否则退回 PATH 上的裸名 `grok`(老行为)。
// 钉的路径照样要过验证清单(调用方原有的 assertGrok*Version 不动),所以 fail-closed 没放松:
// 钉住的是「同一台机上次能起的那个文件」,不是「任何文件」。
import { isAbsolute } from "node:path";

export interface GrokBinaryPin {
  /** 上次启动实际用的绝对路径。 */
  grokBinary?: string;
  /** 上次启动看到的 `grok --version` 横幅,只用于显示/诊断。 */
  grokBinaryVersion?: string;
}

export type GrokBinarySource = "env" | "config" | "path";

export interface GrokBinaryChoice {
  binary: string;
  source: GrokBinarySource;
  /** 钉的路径不能用时的说明(退回 PATH 之前告诉人为什么)。 */
  warning?: string;
}

export function chooseGrokBinary(input: {
  env: { GROK_BINARY?: string };
  config: GrokBinaryPin | null | undefined;
  existsSync: (p: string) => boolean;
}): GrokBinaryChoice {
  const fromEnv = (input.env.GROK_BINARY || "").trim();
  if (fromEnv) return { binary: fromEnv, source: "env" };
  const pinned = (input.config?.grokBinary || "").trim();
  if (pinned) {
    if (!isAbsolute(pinned)) {
      return { binary: "grok", source: "path", warning: `config grokBinary "${pinned}" is not an absolute path; ignoring it` };
    }
    if (!input.existsSync(pinned)) {
      return {
        binary: "grok", source: "path",
        warning: `config grokBinary ${pinned} no longer exists (grok updated or moved?); falling back to PATH — the PATH grok must still be a verified build`,
      };
    }
    return { binary: pinned, source: "config" };
  }
  return { binary: "grok", source: "path" };
}

/** 启动通过校验后要写回的字段。裸名解析成绝对路径由调用方完成(它有 PATH 解析器)。 */
export function grokBinaryPinToRecord(resolvedAbsolute: string, versionLine: string): GrokBinaryPin | null {
  if (!isAbsolute(resolvedAbsolute)) return null;
  return { grokBinary: resolvedAbsolute, grokBinaryVersion: versionLine.trim() };
}

// ── #1615 恢复提示 ────────────────────────────────────────────────────────────
// 钉版只在「上次启动成功过」时有东西可钉。第一次撞上自更新(或 config 里没钉)时,
// 报错原来只说「Install the pinned Grok Build CLI」,而验证过的那个旧二进制**通常还在
// 本机**(grok 自更新把旧版留在 ~/.grok/downloads/,手工装的常在 ~/.grok/bin/grok-<ver>)。
// 这里只**找**并**逐个跑 --version 核对验证清单**,把能用的写进报错,给出一条可以直接
// 复制的恢复命令。不自动换用:fail-closed 语义不变,由人决定用哪一个。

export interface GrokRecoveryCandidate {
  path: string;
  version: string;
}

export function findVerifiedGrokCandidates(input: {
  home: string;
  /** 目录下的条目名;目录不存在时返回 []。 */
  listDir: (dir: string) => string[];
  isRegularFile: (p: string) => boolean;
  /** 跑 `<path> --version`,失败返回 undefined。 */
  probeVersion: (p: string) => string | undefined;
  isVerified: (versionLine: string) => boolean;
  /** 已经失败的那个(不再推荐它自己)。 */
  exclude?: string;
  /** 最多探测几个文件,防止目录里东西太多时启动报错变慢。 */
  maxProbes?: number;
}): GrokRecoveryCandidate[] {
  const dirs = [`${input.home}/.grok/downloads`, `${input.home}/.grok/bin`];
  const max = input.maxProbes ?? 12;
  const seen = new Set<string>();
  const out: GrokRecoveryCandidate[] = [];
  let probes = 0;
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = input.listDir(dir); } catch { names = []; }
    for (const name of [...names].sort().reverse()) {
      if (!/^grok/.test(name) || name.endsWith(".tmp") || name.endsWith(".part")) continue;
      const p = `${dir}/${name}`;
      if (seen.has(p) || p === input.exclude) continue;
      seen.add(p);
      if (!input.isRegularFile(p)) continue;
      if (probes >= max) return out;
      probes++;
      const v = input.probeVersion(p);
      if (v && input.isVerified(v.trim())) out.push({ path: p, version: v.trim() });
    }
  }
  return out;
}

export function grokRecoveryHint(candidates: GrokRecoveryCandidate[], alias: string | undefined): string {
  const who = alias && alias.trim() ? alias.trim() : "<alias>";
  if (candidates.length === 0) {
    return "No verified grok build was found under ~/.grok/downloads or ~/.grok/bin; install a verified build and point GROK_BINARY at it.";
  }
  const first = candidates[0]!;
  const others = candidates.slice(1).map((c) => `${c.path} (${c.version})`);
  return `A verified build is still on this machine: ${first.path} (${first.version}). `
    + `Recover with: GROK_BINARY=${first.path} anet node start ${who}`
    + (others.length ? ` — other verified builds: ${others.join(", ")}` : "")
    + ". The node pins it on the next successful start, so later restarts need no variable.";
}
