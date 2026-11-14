#!/usr/bin/env bun
// #4063-A2 —— 跨节点断言 A：**节点令牌不是这条链的使用者**（N1a / N4a）+ 冒充 node_id 的副作用（N2）
//
// 为什么这样断言（重要，别改成「跨节点应被拒」）：
//   source 目录读 / 会话接入这两条链，凭据闸在**跨节点判定之前**：
//       if (!isHumanCredential(credential)) return fail(403);
//   ⇒ 节点令牌打过去，无论 source_node_id 指向自己还是别人，都是 403。
//   写「跨节点被拒」会把「你是节点不是人」误读成「跨节点隔离」—— 结论对、证据错。
//
// 用法（hub.sh 起好、seed-nodes.ts 造好节点之后）：
//   ROOT=/tmp/anet-iso HUB_PORT=4633 COMMHUB_DB=/tmp/anet-iso/hub.db \
//   bun scripts/isolation-fixture/assert-source-lane.ts
//
// 退出码：全部符合期望 = 0；任一不符 = 1（并打印「命令 / 期望 / 实际」）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.ROOT ?? "/tmp/anet-isolation";
const nodes = JSON.parse(readFileSync(join(ROOT, "nodes.json"), "utf8")) as {
  base_url: string;
  network_id: string;
  nodes: Record<"a" | "b", { alias: string; node_id: string; token: string }>;
};

const A = nodes.nodes.a;
const B = nodes.nodes.b;
const DIR_PATH = "/api/node-session-control/source/directory";

let failures = 0;
function check(label: string, ok: boolean, expected: string, actual: string) {
  if (ok) { console.log(`PASS ${label}`); return; }
  failures += 1;
  console.error(`FAIL ${label}\n  期望: ${expected}\n  实际: ${actual}`);
}

async function post(token: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(nodes.base_url + path, {
      method: "POST",
      // MCP 端要求同时声明两种 Accept，否则 406（与工具调用无关，是传输层约定）
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: (await res.text()).slice(0, 200) };
  } catch (error: any) {
    return { status: 0, text: String(error?.message ?? error) };
  }
}

// ── N1a：节点令牌打源目录链，指向自己 / 指向别人，都应是 403 ─────────────────
const self = await post(A.token, DIR_PATH, { network_id: nodes.network_id, source_node_id: A.node_id, daemon_node_id: A.node_id });
const other = await post(A.token, DIR_PATH, { network_id: nodes.network_id, source_node_id: B.node_id, daemon_node_id: B.node_id });

// 404 = 这条 lane 在夹具里没开（COMMHUB_SOURCE_DIRECTORY_PREVIEW≠1）。那不是通过，是要显式说明的 NOT_RUN。
if (self.status === 404) {
  console.log("NOT_RUN N1a/N4a —— 源目录 lane 未开启（用 COMMHUB_SOURCE_DIRECTORY_PREVIEW=1 起 hub.sh 再跑）");
} else {
  check("N1a 节点令牌指向自己 ⇒ 403", self.status === 403, "403（凭据类型闸）", `${self.status} ${self.text}`);
  check("N1a 节点令牌指向别人 ⇒ 403", other.status === 403, "403（凭据类型闸）", `${other.status} ${other.text}`);
  // 关键：两者必须**完全一致** —— 否则说明差别来自「目标是谁」，那就不是凭据闸而是跨节点判定
  check("N1a 两个目标的响应码一致（证明拒绝来自凭据类型，不是跨节点）",
    self.status === other.status, "两个 status 相等", `self=${self.status} other=${other.status}`);
}

// ── N4a：会话接入链（project-create 下的 attach）同构断言 ────────────────────
// 这条链挂在 project-create 路由里，且要求 directory lane + COMMHUB_SESSION_ATTACH_PREVIEW=1 才存在；
// 未开启时返回 404 —— 那是 NOT_RUN，不是通过。
const ATTACH_PATH = "/api/node-session-control/source/project-create";
const attachSelf = await post(A.token, ATTACH_PATH, {
  network_id: nodes.network_id, source_node_id: A.node_id, daemon_node_id: A.node_id,
  capability: "existing-session-attach-v1-opencode-2.0.22", session_id: "ses_fixture_self",
});
const attachOther = await post(A.token, ATTACH_PATH, {
  network_id: nodes.network_id, source_node_id: B.node_id, daemon_node_id: B.node_id,
  capability: "existing-session-attach-v1-opencode-2.0.22", session_id: "ses_fixture_other",
});
if (attachSelf.status === 404 && attachOther.status === 404) {
  console.log("NOT_RUN N4a —— 接入链未开启（需 COMMHUB_SOURCE_DIRECTORY_PREVIEW=1 且 COMMHUB_SESSION_ATTACH_PREVIEW=1）");
} else {
  check("N4a 节点令牌指向自己 ⇒ 非 2xx", attachSelf.status >= 400,
    ">=400（凭据类型闸）", `${attachSelf.status} ${attachSelf.text.slice(0, 120)}`);
  check("N4a 节点令牌指向别人 ⇒ 非 2xx", attachOther.status >= 400,
    ">=400（凭据类型闸）", `${attachOther.status} ${attachOther.text.slice(0, 120)}`);
  check("N4a 两个目标的响应码一致（证明拒绝来自凭据类型，不是跨节点）",
    attachSelf.status === attachOther.status, "两个 status 相等", `self=${attachSelf.status} other=${attachOther.status}`);
}

// ── N2：A 的令牌声称 B 的 node_id ───────────────────────────────────────────
// 已知行为：不会借到 B 的能力（鉴权绑在令牌的 bound_node_id 上），
// 但**会把 A 自己的 session 行重绑到 B 的 node_id**。这里只断言「不报错 + 回执正常」，
// 归属是否被改由调用方读库确认（脚本不直接连库，保持"只经 HTTP"的边界）。
const impostor = await post(A.token, "/mcp", {
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "report_status", arguments: {
    resume_id: `r_${A.alias}`, alias: A.alias, status: "idle", node_id: B.node_id, node_name: B.alias,
  } },
});
check("N2 冒充 node_id 的 report_status 不会 5xx（行为由读库确认）",
  impostor.status === 200, "200（若改成拒绝，这里要同步改期望）", `${impostor.status} ${impostor.text.slice(0, 120)}`);

if (failures) {
  console.error(`\n${failures} 项不符合期望`);
  process.exit(1);
}
console.log("\n全部符合期望");
