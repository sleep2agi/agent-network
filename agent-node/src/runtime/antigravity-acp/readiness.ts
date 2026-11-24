// agy 的 spawn 侧就绪检查：版本钉 + ACP 子命令存在。
//
// 只做只读探测（--version / acp --help），**不触发 `-p`**：实测未登录时
// `agy -p` 会打印 OAuth URL 并等 60 秒，用它做探活会把节点卡住。
// 登录态探测留给上层用 `agy models`（成功=已登录）。
import { spawnSync } from "node:child_process";
import { withWindowsChildPath } from "../../shared/windows-child-env.js";
import { agyReadinessMessage, compareAgyVersion, formatAgyVersion, parseAgyVersion, pinnedAgyVersion, type AgyPinState, type AgyVersion } from "./version";

export interface AgyReadiness {
  ok: boolean;
  bin: string;
  state: AgyPinState;
  version: AgyVersion | null;
  pinned: string;
  hasAcp: boolean;
  /** True when the `agy` executable itself was not found (ENOENT). */
  missingBinary?: boolean;
  message: string;
  /** Short plain-Chinese user reply (no PATH / AGY_BIN / ACP jargon); raw `message` stays in node logs. */
  userReplyText?: string;
}

export function agyBinary(): string {
  return process.env.AGY_BIN?.trim() || "agy";
}

export function checkAgyReadiness(bin = agyBinary()): AgyReadiness {
  // Windows：探活子进程也要补 PATH（计划任务/服务启动的 PATH 常缺 System32 与 PowerShell v1.0）
  const env = withWindowsChildPath({ ...process.env });
  const ver = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, env });
  const missingBinary = (ver.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const version = ver.status === 0 ? parseAgyVersion(String(ver.stdout ?? "")) : null;
  // 每次检查都读一遍环境变量：AGY_ACCEPTED_VERSION 是给审过新版本的节点用的逃生口。
  const pinned = pinnedAgyVersion();
  const state = compareAgyVersion(version, pinned);
  const help = missingBinary || state === "unknown"
    ? { status: null, stdout: "", stderr: "" }
    : spawnSync(bin, ["acp", "--help"], { encoding: "utf8", timeout: 15_000, env });
  // agy 把 subcommand 的帮助打到 stderr（实测），两路都要看。
  const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  const hasAcp = help.status === 0 && /Agent Client Protocol/i.test(helpText);
  // 2026-11-21 admin 定：版本是**建议**，不是闸门。agy 的自动升级关不掉，
  // 硬钉会让节点在「某天自己升级了」之后直接停摆。所以默认只提示不阻断；
  // 需要严格锁版本的场景（回归基线、发版验证）才设 AGY_STRICT_VERSION=1。
  const strict = process.env.AGY_STRICT_VERSION === "1";
  const ok = hasAcp && state !== "unknown" && (!strict || state === "pinned");
  const base = agyReadinessMessage(state, version, pinned);
  const seen = version ? formatAgyVersion(version) : null;
  const message = missingBinary
    ? `找不到 Antigravity CLI（${bin}，ENOENT）：${base}`
    : state === "unknown"
      ? base
      : !hasAcp
        ? `Antigravity CLI ${seen ?? ""} 版本过低，没有 acp 子命令（需要 >= ${pinned}）：${base}`
        : strict && state !== "pinned"
          ? `${base}（本节点设了 AGY_STRICT_VERSION=1，按严格模式拒绝）`
          : base;
  const userReplyText = ok
    ? undefined
    : missingBinary
      ? "这台机器上找不到 Antigravity 程序。请确认已安装，再发一次。"
      : state === "unknown"
        ? "这台机器上的 Antigravity 程序没正常响应，读不到版本号。请确认它能正常启动，再发一次。"
        : !hasAcp && seen
          ? `这台机器上的 Antigravity 版本过低（当前 ${seen}，需要 ${pinned} 及以上）。请升级后再发一次。`
          : undefined;
  return {
    ok,
    bin,
    state,
    version,
    pinned,
    hasAcp,
    ...(missingBinary ? { missingBinary: true } : {}),
    message,
    ...(userReplyText ? { userReplyText } : {}),
  };
}
