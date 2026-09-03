import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `node-server.ts` 在**三个**地方构造同一份「身份载荷」发给 hub 的 report_status:
//
//   ① main() 开机注册        「registered as …」
//   ② reregister()           SSE 重连后
//   ③ 心跳                    每 3 分钟一次
//
// 🔴 而文件里的注释只提到两处(`Mirrors the payload main() sends at boot`)。
//    2026-08-31 我是靠 `grep -n 'agent: "claude-code"'` 才发现是三处的 ——
//    照注释改两处,第三条路径会**静默地少一个字段**,且只在走到那条路径时才显现。
//
// 所以这道门是**反推**的:凡是构造了 `agent: "claude-code"` 身份载荷的地方,
// 都必须带上同一组字段。将来有人加第四处注册点,漏了会红。
//
// (为什么是 `config_path`:名册里这一格 `claude-code` 族 63 个全空,而
//  `agent-node:*` 各族 100% 有。排查 offline 节点时第一个问题是「还能不能起回来」,
//  那要看 config 还在不在 —— #1648 里 11 个节点因此只能写「判不了」。)

const SRC = readFileSync(join(import.meta.dir, "node-server.ts"), "utf-8");
// 🔴 去掉注释行:源码里既有"东西"也有"关于它的描述",裸 grep 会命中后者。
const CODE = SRC.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** 每个身份载荷块 = 从 `agent: "claude-code"` 起到该对象字面量结束。 */
function identityPayloads(src: string): string[] {
  const out: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*agent:\s*"claude-code",\s*$/.test(lines[i]!)) continue;
    const indent = lines[i]!.match(/^\s*/)![0].length;
    const block: string[] = [];
    // 往上收到对象起点(callCommHub 那一行),往下收到缩进变浅
    for (let j = i - 6; j < i; j++) if (j >= 0) block.push(lines[j]!);
    for (let j = i; j < Math.min(lines.length, i + 12); j++) {
      const l = lines[j]!;
      if (j > i && l.trim() && (l.match(/^\s*/)![0].length < indent)) break;
      block.push(l);
    }
    out.push(block.join("\n"));
  }
  return out;
}

describe("node-server 的身份载荷(三处)", () => {
  const blocks = identityPayloads(CODE);

  it("取集正控:确实解析出了 3 个身份载荷(空集会让下面恒绿)", () => {
    expect(blocks.length).toBe(3);
    for (const b of blocks) expect(b).toContain('agent: "claude-code"');
  });

  it("三处都带 project_dir —— 这一格本来就有,当基准", () => {
    for (const b of blocks) expect(b).toContain("project_dir: process.cwd()");
    // #1727 —— 六个监控字段(uptime/rss/cpu/load/disk/version 里的前五个)由这两把采集器产;
    // 三处身份载荷少任何一处,那条路径上的节点在 Dashboard 就只剩「在线」。
    for (const b of blocks) expect(b).toContain("host: getHostTelemetry()");
    for (const b of blocks) expect(b).toContain("process_telemetry: getProcessTelemetry()");
  });

  it("🔴 三处都带 config_path —— 加第四处注册点时漏了会红", () => {
    const missing = blocks.filter(b => !b.includes("config_path: CONFIG_PATH"));
    expect(missing.length).toBe(0);
  });

  it("config_path 不存在时不发这个字段(发一个不存在的路径比不发更糟)", () => {
    expect(CODE).toContain("existsSync(p) ? p : undefined");
  });

  it("路径用的是 cwd + ALIAS,与 activityLog 同源,不另外猜", () => {
    expect(CODE).toContain('join(process.cwd(), ".anet", "nodes", ALIAS, "config.json")');
    expect(CODE).toContain("createActivityLogSink(process.cwd(), ALIAS)");
  });
});
