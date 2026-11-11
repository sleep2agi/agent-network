// 源目录 / 新建节点 / 复用 Session 的能力上报（#4495）。
//
// 钉住三件事：
//   1) 只有 host_supervisor + linux + 安全 Hub 才报；别的角色/平台一条都不出现（快照逐字不变）；
//   2) 每条能力仍要求 transport 在 config 里配好 —— 配了才报，没配就是没打算开；
//   3) 环境变量 `=0` 能显式关掉（应急开关）；不设不再等于关闭（这正是生产上 0/7 上报的原因）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { laneEnabled, sourceCapabilities } from "./daemon-source-capabilities";
import { PROJECT_CREATE_CAPABILITY } from "../../contracts/session-project-create";
import { SESSION_ATTACH_CAPABILITY } from "../../contracts/session-project-create";
import { SOURCE_DELIVERY_CAPABILITY } from "../../contracts/session-source-delivery";
import { SOURCE_DIRECTORY_CAPABILITY } from "../../contracts/session-source-directory";
import { SOURCE_FORK_CAPABILITY } from "../../contracts/session-source-transport";

const fullConfig = {
  sourceDirectoryTransport: SOURCE_DIRECTORY_CAPABILITY,
  sourceForkTransport: SOURCE_FORK_CAPABILITY,
  projectNewSessionTransport: PROJECT_CREATE_CAPABILITY,
  sessionAttachTransport: SESSION_ATTACH_CAPABILITY,
};
const base = { role: "host_supervisor", platform: "linux", env: {}, config: fullConfig, secureHub: true, createOk: true };

describe("laneEnabled —— 上报与拉起共用同一判断", () => {
  test("未设 / \"1\" ⇒ 开；\"0\" ⇒ 关", () => {
    expect(laneEnabled({}, "ANET_SOURCE_FORK_PREVIEW")).toBe(true);
    expect(laneEnabled({ ANET_SOURCE_FORK_PREVIEW: "1" }, "ANET_SOURCE_FORK_PREVIEW")).toBe(true);
    expect(laneEnabled({ ANET_SOURCE_FORK_PREVIEW: "0" }, "ANET_SOURCE_FORK_PREVIEW")).toBe(false);
  });
  test("源码守护：worker 启动不能再退回 `=== \"1\"`（否则报了能力却不干活）", () => {
    const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    const start = src.indexOf("createSessionSourceTransportWorker({");
    const block = src.slice(start, src.indexOf("pin:", start));
    expect(start).toBeGreaterThan(0);
    expect(block).not.toContain('_PREVIEW === "1"');
    for (const k of ["ANET_SOURCE_DIRECTORY_PREVIEW", "ANET_PROJECT_NEW_SESSION_PREVIEW", "ANET_SESSION_ATTACH_PREVIEW", "ANET_SOURCE_FORK_PREVIEW"]) {
      expect(block).toContain(`laneEnabled(process.env, "${k}")`);
    }
  });
});

describe("daemon 能力上报", () => {
  test("配置齐 + 不设环境变量 ⇒ 五条全报（以前要求 env=1，才会有 0/7）", () => {
    expect(sourceCapabilities(base)).toEqual({
      source_directory_read: SOURCE_DIRECTORY_CAPABILITY,
      project_new_session: PROJECT_CREATE_CAPABILITY,
      session_attach: SESSION_ATTACH_CAPABILITY,
      source_node_delivery: SOURCE_DELIVERY_CAPABILITY,
      source_fork_transport: SOURCE_FORK_CAPABILITY,
    });
  });

  test("环境变量 =0 显式关闭对应能力（应急）", () => {
    const off = sourceCapabilities({ ...base, env: { ANET_SOURCE_FORK_PREVIEW: "0" } });
    expect(off.source_fork_transport).toBeUndefined();
    expect(off.source_node_delivery).toBeUndefined();
    expect(off.source_directory_read).toBe(SOURCE_DIRECTORY_CAPABILITY);
  });

  test("transport 没配 ⇒ 不报（配置才是意图表达）", () => {
    const got = sourceCapabilities({ ...base, config: { sourceForkTransport: SOURCE_FORK_CAPABILITY } });
    expect(got).toEqual({
      source_node_delivery: SOURCE_DELIVERY_CAPABILITY,
      source_fork_transport: SOURCE_FORK_CAPABILITY,
    });
  });

  test("非 host_supervisor / 非 linux / 不安全 Hub ⇒ 一条都不报", () => {
    expect(sourceCapabilities({ ...base, role: "node" })).toEqual({});
    expect(sourceCapabilities({ ...base, platform: "darwin" })).toEqual({});
    expect(sourceCapabilities({ ...base, secureHub: false })).toEqual({});
  });

  test("fork 依赖「现在真能建节点」", () => {
    const got = sourceCapabilities({ ...base, createOk: false });
    expect(got.source_fork_transport).toBeUndefined();
    expect(got.source_directory_read).toBe(SOURCE_DIRECTORY_CAPABILITY);
  });
});
