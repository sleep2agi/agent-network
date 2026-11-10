// 2026-11-10 —— 「起这份 agent-node 的 anet CLI 是哪个版本」必须真的报得上去。
//
// 为什么这条测试重要：`config_snapshot.anet_version` 是静态占位值（写死 0.1.0），
// 客户端因此给不出「这台机器该装哪一对包」，只能建议 `agent-node@preview` ——
// 装完与本地 CLI 不成对，CLI 拒绝启动，节点离线。而这条链路的失败模式是**静默**的：
// 少一格字段界面上只是「没有那个提示」，不报错，可以一路错到有人想起来。
//
// 分两层断言：
//   ① 行为层：这一格在 env 有/没有/形状不对时的取值（这是真正会被调用的代码）；
//   ② 接线层：cli.ts 真的把这一格摊进了**心跳的 config_snapshot**（不是顶层 ——
//      report_status 的顶层 schema 不认它，会被静默丢弃），且读的是**启动时**抓的那份。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHED_BY_CLI_VERSION_ENV,
  LAUNCHED_BY_CLI_VERSION_FIELD,
  launchedByCliVersionField,
  readLaunchedByCliVersion,
} from "./launched-by-cli-version";

const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

/** 心跳上报对象里 `config_snapshot: configApplyDraining ? undefined : { … }` 那一段。 */
function heartbeatSnapshotRegion(): string {
  const start = src.indexOf("config_snapshot: configApplyDraining");
  expect(start).toBeGreaterThan(-1);
  // 该函数以 `// #672` 那段注释收尾（见 cli.ts），比数括号稳：snapshot 里全是嵌套字面量。
  const end = src.indexOf("// #672", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** 与 cli.ts 完全相同的组合：启动时读一次 → 心跳里摊开来。 */
function snapshotFragment(env: NodeJS.ProcessEnv) {
  return launchedByCliVersionField(readLaunchedByCliVersion(env));
}

describe("launched_by_cli_version —— env 有值时如实上报", () => {
  test("预发布版与稳定版都收", () => {
    expect(snapshotFragment({ [LAUNCHED_BY_CLI_VERSION_ENV]: "2.3.0-preview.226" }))
      .toEqual({ launched_by_cli_version: "2.3.0-preview.226" });
    expect(snapshotFragment({ [LAUNCHED_BY_CLI_VERSION_ENV]: "0.9.0" }))
      .toEqual({ launched_by_cli_version: "0.9.0" });
  });

  test("前后空白 tolerate —— env 里的值经常带尾巴，trim 后再判形状", () => {
    expect(snapshotFragment({ [LAUNCHED_BY_CLI_VERSION_ENV]: " 2.3.0-preview.7\n" }))
      .toEqual({ launched_by_cli_version: "2.3.0-preview.7" });
  });

  test("字段名与 Hub 侧约定一致（同一根字符串，不是两处字面量）", () => {
    expect(LAUNCHED_BY_CLI_VERSION_FIELD).toBe("launched_by_cli_version");
    expect(Object.keys(snapshotFragment({ [LAUNCHED_BY_CLI_VERSION_ENV]: "1.0.0" })))
      .toEqual([LAUNCHED_BY_CLI_VERSION_FIELD]);
  });
});

describe("launched_by_cli_version —— 缺席/形状不对时**一格都不多发**", () => {
  const ABSENT = [
    {},
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "" },
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "   " },
    // 形态不认：宁可「没报」也不要报一个假版本（假版本正是这次要修的 bug 的成因）
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "preview" },
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "2.3" },
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "v2.3.0-preview.1" },
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "2.3.0-preview" },
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "2.3.0+meta" },
    { [LAUNCHED_BY_CLI_VERSION_ENV]: "1.0.0; rm -rf /" },
    // 长度上限（Hub 侧 z.string().max(64) 同一条口径）
    { [LAUNCHED_BY_CLI_VERSION_ENV]: `1.0.0${"0".repeat(60)}` },
  ];
  test("上面每一个反例都一格不发（逐个断言，失败时能看出是哪一个）", () => {
    for (const env of ABSENT) {
      const fragment = snapshotFragment(env as NodeJS.ProcessEnv);
      expect(fragment).toEqual({});
      // 关键：不是 `{key: undefined}` —— 序列化后必须一个字节都不多。
      expect(JSON.stringify(fragment)).toBe("{}");
      expect(LAUNCHED_BY_CLI_VERSION_FIELD in fragment).toBe(false);
    }
  });

  test("非字符串（有人往 env 里塞了别的东西）同样当没报", () => {
    expect(readLaunchedByCliVersion({ [LAUNCHED_BY_CLI_VERSION_ENV]: 42 } as any)).toBeUndefined();
    expect(readLaunchedByCliVersion({ [LAUNCHED_BY_CLI_VERSION_ENV]: undefined } as any)).toBeUndefined();
  });

  test("绝不回退成占位值/默认版本 —— 那正是 anet_version 造成过的假象", () => {
    expect(readLaunchedByCliVersion({})).toBeUndefined();
    expect(JSON.stringify(snapshotFragment({}))).not.toContain("0.1.0");
  });
});

describe("接线：心跳 config_snapshot 里真的有这一格", () => {
  test("摊在 config_snapshot 里面，且带条件（没有就不出现）", () => {
    const region = heartbeatSnapshotRegion();
    expect(region).toContain("...launchedByCliVersionField(INITIAL_LAUNCHED_BY_CLI_VERSION),");
    // 镜像否定：不许无条件写死一个键（那会在没有版本时也发出去）
    expect(region).not.toMatch(/^\s*launched_by_cli_version:/m);
  });

  test("不在顶层 —— 顶层 schema 不认它，会被静默丢弃", () => {
    const topLevel = src.slice(0, src.indexOf("config_snapshot: configApplyDraining"));
    expect(topLevel).not.toContain("launched_by_cli_version");
  });

  test("版本在**启动时**抓一次（config.json 的 env 合并之前），不是每次心跳现读", () => {
    const capture = src.indexOf("const INITIAL_LAUNCHED_BY_CLI_VERSION = readLaunchedByCliVersion(process.env)");
    expect(capture).toBeGreaterThan(-1);
    // config.json 的 env 合并就在这里。启动者边界必须比它早，否则 profile 能改这句自报的真假。
    const merge = src.indexOf('if (fileConfig.env && typeof fileConfig.env === "object") {');
    expect(merge).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(merge);
  });

  test("没有去动 anet_version（那是节点自身的另一码事）", () => {
    expect(src).not.toContain("anet_version: INITIAL_LAUNCHED_BY_CLI_VERSION");
    expect(src).not.toContain("launched_by_cli_version: fileConfig.anet_version");
  });
});
