// 2026-10-31 —— 把「本进程的 systemd 托管状态」接进上报快照（restart_supervised 重构的接线）。
//
// 为什么单独一个模块而不是塞进 cli.ts：
//   cli.ts 已经有 2 万行，而这里要做三件有状态的事（探测自身 unit 名 / TTL 缓存 / 调 systemctl），
//   分出来才能用注入的 reader 做测试，而不必在测试里真的起 systemd。
//
// 🔴 三条铁律：
//   ① **读不到 ⇒ unknown**，绝不折成「不受托管」（否则一个无法判断的节点会被当成裸起节点告警）
//   ② TTL 用 30s：`daemon-reload` 能在进程运行期间改掉 Restart=/Type= ⇒ 静态不能绑进程
//   ③ 只读 `systemctl show`；不 show -p 多次、不 status、不 list

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  classifySupervision,
  createUnitFactsCache,
  parseSystemctlShow,
  type UnitFacts,
  type UnitFactsCache,
} from "./systemd-unit-facts.js";

/**
 * 从 `/proc/self/cgroup` 推自身 unit 名。
 *
 * 形态示例：
 *   0::/system.slice/anet-node.service
 *   4:cpu:.../user.slice/user-1000.slice/session-3.scope
 * ⇒ 取最后一个非空路径段；以 `.service` / `.scope` 结尾才算候选。
 *
 * ⚠️ 取到 `.scope` 是**正常情况**（pm2 / 交互会话下常见）——它表示「不是由 .service 托管」，
 *    但那不是 `not_supervised` 的证据，而应当交给 classifySupervision 用 LoadState/Type 判。
 *    所以这里只负责「名字」，不负责「结论」。
 */
export function detectOwnUnitName(cgroupText: string): string | null {
  for (const line of cgroupText.split("\n")) {
    const seg = line.split(":").slice(2).join(":").trim();
    if (!seg) continue;
    const parts = seg.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /\.(service|scope)$/.test(last)) return last;
  }
  return null;
}

function readCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

/** 默认 reader：真的调 systemctl（只 show，只读）。任何失败都抛，由缓存层转成 unknown。 */
function systemctlReader(unit: string): UnitFacts {
  const out = execFileSync(
    "systemctl",
    ["show", unit, "-p", "LoadState", "-p", "Type", "-p", "Restart", "-p", "SuccessExitStatus"],
    { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] },
  );
  return parseSystemctlShow(out, Date.now());
}

let cache: UnitFactsCache | null = null;
let cachedUnit: string | null | undefined;

/**
 * 给心跳上报用的三格（全是三态/可空，绝不给一个“看起来是结论”的 false）：
 *   systemd_supervision         : supervised | not_supervised | unknown
 *   systemd_supervision_reason  : 为什么（unknown 时必须说明哪个前提没满足）
 *   respawns_on_exit75          : true | false | null（null = 算不出来）
 */
export function systemdSupervisionSnapshot(
  opts: { reader?: (unit: string) => UnitFacts; cgroupText?: string } = {},
): {
  systemd_supervision: "supervised" | "not_supervised" | "unknown";
  /** **判出来之后**是哪个旋钮决定的（只在 not_supervised / supervised 时有意义）。 */
  systemd_supervision_knob: string | null;
  /** 只在 unknown 时填，且一律带 `missing:` 前缀 —— 它只回答「为什么判不出来」。 */
  systemd_supervision_reason: string | null;
  respawns_on_exit75: boolean | null;
} {
  const unit = detectOwnUnitName(opts.cgroupText ?? readCgroup());
  if (!unit) {
    return {
      systemd_supervision: "unknown",
      systemd_supervision_knob: null,
      systemd_supervision_reason: "missing:own_unit_not_identifiable",
      respawns_on_exit75: null,
    };
  }
  // 缓存键是 unit 名 ⇒ 换 unit（理论上不会）立即失效
  if (!cache || cachedUnit !== unit || opts.reader) {
    cache = createUnitFactsCache(opts.reader ?? systemctlReader, { ttlMs: 30_000 });
    cachedUnit = unit;
  }
  const facts = cache.get(unit);
  const verdict = classifySupervision(facts);
  // 🔴 2026-10-31 —— reason 只回答「为什么判不出来」；「判出来了，结果是 X」属于 verdict。
  //    早先两者混在一个字段里 ⇒ 消费方无法区分「不可判」与「判定为否」。
  if (verdict.kind === "unknown") {
    return {
      systemd_supervision: "unknown",
      systemd_supervision_knob: null,
      systemd_supervision_reason: `missing:${verdict.reason}`,
      respawns_on_exit75: null,
    };
  }
  if (verdict.kind === "not_supervised") {
    return {
      systemd_supervision: "not_supervised",
      // 判定为否时，说清是哪个旋钮否的（load_state:… / type:… / restart_no / restart_unset）
      systemd_supervision_knob: verdict.reason,
      systemd_supervision_reason: null,
      respawns_on_exit75: false,
    };
  }
  return {
    systemd_supervision: "supervised",
    systemd_supervision_knob: verdict.respawnsOnExit75 === null ? "respawn_undecidable" : "ok",
    systemd_supervision_reason: null,
    respawns_on_exit75: verdict.respawnsOnExit75,
  };
}
