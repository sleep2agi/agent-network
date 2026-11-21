// agy 的 spawn 侧就绪检查：版本钉 + ACP 子命令存在。
//
// 只做只读探测（--version / acp --help），**不触发 `-p`**：实测未登录时
// `agy -p` 会打印 OAuth URL 并等 60 秒，用它做探活会把节点卡住。
// 登录态探测留给上层用 `agy models`（成功=已登录）。
import { spawnSync } from "node:child_process";
import { agyReadinessMessage, compareAgyVersion, parseAgyVersion, pinnedAgyVersion, type AgyPinState, type AgyVersion } from "./version";

export interface AgyReadiness {
  ok: boolean;
  bin: string;
  state: AgyPinState;
  version: AgyVersion | null;
  pinned: string;
  hasAcp: boolean;
  message: string;
}

export function agyBinary(): string {
  return process.env.AGY_BIN?.trim() || "agy";
}

export function checkAgyReadiness(bin = agyBinary()): AgyReadiness {
  const ver = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
  const version = ver.status === 0 ? parseAgyVersion(String(ver.stdout ?? "")) : null;
  // 每次检查都读一遍环境变量：AGY_ACCEPTED_VERSION 是给审过新版本的节点用的逃生口。
  const pinned = pinnedAgyVersion();
  const state = compareAgyVersion(version, pinned);
  const help = spawnSync(bin, ["acp", "--help"], { encoding: "utf8", timeout: 15_000 });
  // agy 把 subcommand 的帮助打到 stderr（实测），两路都要看。
  const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  const hasAcp = help.status === 0 && /Agent Client Protocol/i.test(helpText);
  const ok = state === "pinned" && hasAcp;
  const message = !hasAcp
    ? `Antigravity CLI 这个版本没有 acp 子命令（需要 >= ${pinned}）：${agyReadinessMessage(state, version, pinned)}`
    : agyReadinessMessage(state, version, pinned);
  return { ok, bin, state, version, pinned, hasAcp, message };
}
