# 用户页内部材料（2026-09-25 从 docs-site 用户文档移出）

> 以下内容原在 anet.sh 用户页里，属于测试记录 / 方法论 / 来龙去脉，不再放在用户页。按来源页分组，保留原有的 issue / PR / RFC 线索，方便维护者追溯。

## guide/runtimes.md（中英）

### 通道可用性的来历

- 2026-08-27 容器内真机实测：当天 npm `latest` = `2.3.0-preview.47`，`preview` = `2.3.0-preview.51`，`anet node create` 选单 7 个 runtime 全部列出，`anet daemon` 与 `anet grok attach` 也存在。用户页据此写成「agent-network ≥ `2.3.0-preview.47`」。
  注意：`.47` 是**观测到的版本**，不是二分出来的首个版本；真正的下界可能更早。
- 在此之前 `latest` 长期停在 `2.2.21`，当时页面写的「codex-app-server / opencode-cli 仅预览版」「grok-build-cli 不在任何包中」在那个版本上是对的。教训：行为类说法要连版本号一起写，换 dist-tag 结论可能反过来。
- `docs/RELEASE-SOP.md` 的逐次发版重核表登记了 runtimes.md（中英）；#1298 把带具体版本号的通道结论写回页面后，这两页重新需要随发版核对。

### daemon 代创共存 runtime

- #1298：daemon 侧 `create_node` 曾拒绝三个共存 runtime；#1301 把它们加入 daemon 侧 runtime 集合。用户页没有写具体修复版本（尚未核实 #1301 首次进入哪个 agent-network / agent-node 版本）；如果要写成 `≥ X`，先查发版记录。

### opencode-cli

- macOS 支持来自 #1845（包身份校验、`$TMPDIR` 启动隔离、`ps`/`lsof` 进程归属三层等价物），2026-09-07 在 Mac mini 上端到端验证：注册 → 收任务 → 回复 → 停机。
- 默认禁用本机工具那段的动机：#943，一个需要 `bash` 的任务回来的是一段未执行的工具调用原文，hub 记 `failed=false`。
- 第三方网关接法与三条部署前置是 2026-09-17 实测；当时用的是 `opencode-ai@1.18.1`（用户页已改成 `<pin>`）。
- 页面上 `opencode-cli` 仍是 RFC-029 迭代中的预览形态。

### claude-agent-sdk

- in-process SDK MCP 是 #102 Option A。
- runtime-first wizard（先选 runtime，vendor 只在 claude-agent-sdk 分支出现）来自 v0.9.2 / #133。
- 「VENDORS 里的都是真实调用验证过的，未验证 provider 不进列表」是 #104-B 的设计。

### codex-sdk / codex-direct-stdio

- `codex-direct-stdio` 是 #141，v0.10.0 引入，约 155 LOC 的直连 stdio JSON-RPC 客户端，67-method v2 协议面；当时的依据是 `agent-node@2.4.0`。
- 绕开的是 `@openai/codex-sdk` `--mcp-config` HTTP 传输那条 bug 链（#102 hang root cause family）。
- 当时写的计划：v0.10.x 默认仍走 wrapper，v0.11.0 计划翻转默认并把开关改成 `ANET_CODEX_LEGACY_SDK=1` opt-out。用户页只保留「默认仍走 wrapper」，不再写计划（architecture.md 仍有同样的计划表述，未在本次范围内）。

### codex-app-server（RFC-030）

- 验证状态原文（Phase 0A / preview 形态）：方案 A 直接双客户端，真机自验——桥 17 + client 12 单测、741 全量零回归、隔离 hub 真节点 e2e `send_task`→codex→`send_task` 闭环 PASS。生产形态是方案 B 单 upstream Policy Gateway（排队仲裁 + 审批只递人类 + 最小权限投递口），见 RFC-030 §18 实现现状 + §8 硬门。
- 「回复用 send_task」是实测结论：`send_reply` 不 SSE 唤醒直接发起方。
- 标题原为「codex-app-server（Codex TUI 桥, RFC-030）」，改名后用显式 `{#codex-app-server-codex-tui-桥-rfc-030}` / `{#codex-app-server-codex-tui-bridge-rfc-030}` 保住旧锚点。
- test535 断言 runtimes 页含 `node start codexbridge --copresence`；此前页面只写了 `anet node start codexbridge`，该断言在 origin/main 上就不成立，本次改为 `anet node start codexbridge --copresence`。

### grok-build-acp

- v0.10.8 起正式接入；v0.10.11 / #204 加每节点独立 cwd，解决多节点身份污染。

### claude-code-cli

- v0.8.2 修了 session resume 默认丢失的 bug（见 changelog）。

## deploy/clean-server.md（中英）

- 页面原本按「维护者在干净机器上实测踩过一遍的路径」写，故障排查表原名「故障排查表（8 坑 mapping）」，行序是「今天实测踩过的顺序」。
- 各坑对应的 issue：
  - 坑 1（没装 Bun → `spawn bunx ENOENT`）：#235 跟进 preflight + 友好提示。
  - 坑 2（hub 没起 → `fetch failed`）：#237 主条跟进 fetch 分类报错。
  - 坑 3（向导默认高亮 `claude-agent-sdk`）：#237 坑 3，已知 UX 痛点，计划调整 wizard 默认。
  - 坑 4（向导开头 "optional Telegram channel" 误导）：#237 坑 4。
  - 坑 5（npx 懒加载没拉到 agent-node）：#237 坑 5；修复是 PR #239，进入 `2.3.0-preview.38`。
  - 坑 5.5（detached 假报 ✅）：PR #895，2026-08-17 合入，随 `2.3.0-preview.40` 发布；`anet project up` 退出码修复是 PR #896，同随 `preview.40`。
  - 坑 6（dev-channels 确认框）：#237 坑 6。
- `anet hub --help` 在 2.2.12 漏列 `stop` / `status`：#240 / PR #241 修复。
- channel allowlist 覆盖语义：页面原写「未来会改 append」，没有对应的跟踪 issue，已从用户页删去承诺。
- 原页「§8 持久化」下的子节编号是 7.1 / 7.2，英文页还有两个「## 7.」；本次统一改成 8.1 / 8.2（页内链接已同步，没有外部入链指向旧锚点）。
- 原页写「anet 暂未 ship 官方 `--daemon` flag」；现在有 `anet daemon` 子命令，这句容易误导，已删。

## troubleshooting/is-this-node-alive.md（中英）

- `status = offline` 那一格的来源：2026-08-19 容器内实测（#1027）——一个活着、已注册、SSE 已连的节点，`anet node stop` 打出 `"<alias>" is not running locally (server notified offline)` 并返回 0，两个进程 9 分钟后仍在。节点是测试用裸后台进程起的，不在 tmux 里。该观测只发生过一次，后续同路径完整跑没有复现（当时同时跑着 2~3 个容器，是否资源竞争没有证据）。
- `status = blocked` 那一格的来源：2026-08-31 在生产 hub 上实测，一台 `agent-node:grok-build-cli`，名册 `blocked`、心跳 4 分钟前，派一条任务 22 秒回复。#1548 另一个例子：负责打安装包的节点显示 `blocked` 8.3 小时，实际一直活着且无替补。
- `status = idle` 四种现实第 2 条（TUI 显示 `Wandering… (1m 12s · ↓ 2.1k tokens)` 而 `anet node ls` 报 `idle`）是实测观察。
- 统计旁证：在一个百余节点的舰队里实测，心跳新鲜的节点里 `status` 只取到一个值（全部 `idle`），没有任何一个 `working`。用户页改成了定性表述。
- stdout 假报 ✅：PR #895 修复，`2.3.0-preview.40` 起；`anet project up` 退出码可信自 PR #896（同随 `preview.40`）。
