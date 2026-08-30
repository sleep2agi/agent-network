import { describe, expect, test } from "bun:test";
import {
  DAEMON_STATE_CHANGING, NODE_STATE_CHANGING, PROJECT_STATE_CHANGING,
  daemonSubcommandRedirect, nodeSubcommandRedirect, projectSubcommandRedirect,
} from "./subcommand-redirect";

describe("daemonSubcommandRedirect", () => {
  test("🔴 suggestSimilar 会误导的那三个动词,必须先被这里接住", () => {
    // 实测(用仓里的 suggestSimilar 本身跑的):
    //   rm → "up"(创建+启动)   state → "start"   stat → "start"
    for (const verb of ["rm", "state", "stat"]) {
      const out = daemonSubcommandRedirect(verb, "d1");
      expect(out).not.toBeNull();
      expect(out!.join("\n")).toContain("anet node");
    }
  });

  test("🔴 任何重定向都不能指向一个会改变状态的 daemon 子命令", () => {
    // 这一条是整个模块的立论:提示不能把「只读/销毁」意图导向「动世界」。
    for (const verb of ["stop", "kill", "halt", "delete", "del", "rm", "remove", "status", "state", "stat", "ps", "info"]) {
      const line = daemonSubcommandRedirect(verb, "d1")![1];
      for (const bad of DAEMON_STATE_CHANGING) {
        expect(line).not.toContain(`anet daemon ${bad}`);
      }
    }
  });

  test("停 / 删 / 看 各自指向正确的 node 级命令", () => {
    expect(daemonSubcommandRedirect("stop", "d1")![1].trim()).toBe("anet node stop d1");
    expect(daemonSubcommandRedirect("rm", "d1")![1].trim()).toBe("anet node delete d1");
    expect(daemonSubcommandRedirect("status", "d1")![1].trim()).toBe("anet node ls");
  });

  test("没给名字时用占位符,提示仍然可以照抄", () => {
    expect(daemonSubcommandRedirect("stop")![1].trim()).toBe("anet node stop <name>");
    expect(daemonSubcommandRedirect("stop", "--force")![1].trim()).toBe("anet node stop <name>");
  });

  test("真正的拼写错误不归它管 —— 交回给 suggestSimilar", () => {
    // "strat" 是 "start" 的错拼,应当返回 null 让原有的相似度提示接手。
    for (const s of ["strat", "lsit", "int", "", "  ", "totally-unknown"]) {
      expect(daemonSubcommandRedirect(s, "d1")).toBeNull();
    }
    expect(daemonSubcommandRedirect(undefined as unknown)).toBeNull();
    expect(daemonSubcommandRedirect(42 as unknown)).toBeNull();
  });

  test("大小写与空白不敏感", () => {
    expect(daemonSubcommandRedirect("  STOP ", "d1")![1].trim()).toBe("anet node stop d1");
  });
});

describe("project / node —— 同一条不变式必须对三组都成立", () => {
  // 实测(用仓里的 suggestSimilar 本身跑的):
  //   anet project rm    → 建议 "up"     想删项目,被指去「启动项目里所有节点」
  //   anet node    state → 建议 "start"  想看状态,被指去「启动」
  const GROUPS = [
    { name: "daemon",  fn: daemonSubcommandRedirect,  mutating: DAEMON_STATE_CHANGING,  verbs: ["stop", "rm", "delete", "status", "state", "stat", "ps", "info", "kill"] },
    { name: "project", fn: projectSubcommandRedirect, mutating: PROJECT_STATE_CHANGING, verbs: ["rm", "remove", "delete", "stop", "status", "state", "stat", "ps"] },
    { name: "node",    fn: nodeSubcommandRedirect,    mutating: NODE_STATE_CHANGING,    verbs: ["status", "state", "stat", "ps", "info"] },
  ];

  test("🔴 三组的任何重定向都不能指向该组里会改变状态的子命令", () => {
    for (const g of GROUPS) {
      for (const v of g.verbs) {
        const out = g.fn(v, "x1");
        expect(out).not.toBeNull();
        const line = out![1];
        for (const bad of g.mutating) expect(line).not.toContain(`anet ${g.name} ${bad}`);
      }
    }
  });

  test("project rm 指向 down,并说清项目级没有删除", () => {
    const out = projectSubcommandRedirect("rm")!;
    expect(out[1].trim()).toBe("anet project down");
    expect(out[2]).toContain("项目级没有删除");
  });

  test("node state / stat 指向 node ls,而不是 start", () => {
    for (const v of ["state", "stat", "status"]) {
      expect(nodeSubcommandRedirect(v, "n1")![1].trim()).toBe("anet node ls");
    }
  });

  test("每组的提示都点名自己的组 —— 不能串组", () => {
    expect(daemonSubcommandRedirect("stop", "d1")![0]).toContain("anet daemon stop");
    expect(projectSubcommandRedirect("rm")![0]).toContain("anet project rm");
    expect(nodeSubcommandRedirect("state", "n1")![0]).toContain("anet node state");
  });

  test("真拼写错仍交回 suggestSimilar", () => {
    expect(projectSubcommandRedirect("dwon")).toBeNull();
    expect(nodeSubcommandRedirect("strat")).toBeNull();
  });
});
