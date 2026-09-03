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
