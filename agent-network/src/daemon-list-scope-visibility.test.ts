import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #1722 —— `anet daemon list` 的 "locally" 指的是**当前目录**,不是这台机器:
//   listProfileIds() 读 nodesDir() = join(process.cwd(), ".anet", "nodes")
// 在别的目录跑,同机的 daemon 一个都看不见,而原来的输出里没有任何东西
// 说得出这一点 —— 读的人会得出「这台机器上没有 daemon」这个更强的结论。
//
// 🔴 "No host_supervisor daemons" 这个子串被 tests/qa-anet-daemon-cmd/run.sh
//    用 grep -q 钉着。本测试同时钉住「它还在」和「后面补了目录」,
//    这样以后谁想改文案,两边会一起红,而不是悄悄破坏那个 QA 套件。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
// 源码里既有「东西」也有「关于它的注释」——判之前去掉注释行。
const CODE = CLI.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("#1722 daemon list 要说清它扫的是哪个目录", () => {
  it("取集正控：daemonListCommand 还在，且仍从 listProfileIds 取集", () => {
    expect(CODE).toContain("async function daemonListCommand()");
    expect(CODE).toContain("listProfileIds()");
  });

  it("🔴 QA 套件钉着的子串没有被改掉", () => {
    // tests/qa-anet-daemon-cmd/run.sh 用 grep -q "No host_supervisor daemons"
    expect(CODE).toContain("No host_supervisor daemons");
  });

  it("空清单和非空清单都打印扫描目录", () => {
    const n = [...CODE.matchAll(/scanned: \$\{nodesDir\(\)\}/g)].length;
    expect(n).toBe(2); // 两个分支各一处
  });

  it("并且说明「按目录存放」——否则用户不知道换个目录会看到别的清单", () => {
    expect(CODE).toContain("节点配置按目录存放");
  });

  it("nodesDir 仍然是 cwd 相对的（这条结论的前提）", () => {
    expect(CODE).toContain('join(process.cwd(), ".anet", "nodes")');
  });
});
