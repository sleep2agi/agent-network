# 方案：单机多 codex 节点的 app-server 拓扑（共享一个 vs 每节点一个）

> 通信龙 · 2026-07-10 · 回答 Vincent「同一个服务器上用一个 app-server 的方式可靠吗？」

## 1. 背景 / 问题

要把 ~48 个 codex 节点从 codex-sdk 切到 codex-app-server（codex-cli）runtime。当前落地方式是**每节点一个 `codex app-server` 进程**（约 200–240MB idle）。48 个 → 约 **10–14GB 常驻内存**。所以问：**能不能一台机器只跑一个 app-server、所有节点当它上面的不同 thread？**

## 2. codex app-server 的真实能力（实测 0.144 schema）

`thread/start` 参数**支持 per-thread**：`cwd`、`model`、`sandbox`、`approvalPolicy`、以及一个自由的 `config` 对象。所以**一个 app-server 确实能同时装多条 thread，每条用不同工作目录 / 模型 / 沙箱**——这一层比"一个进程一套配置"要灵活，是共享方案的有利点。

## 3. 共享单 app-server 的三个不可靠点

### 3.1 单点故障（SPOF）— 最致命
一个 app-server 进程崩溃 / 卡死 / 升级重启 → **它上面所有节点的会话全挂**。每节点独立进程则互相隔离，一个崩不影响别的。48 个团队角色押在一个进程上，风险不可接受。

### 3.2 CommHub 身份是进程级，做不到 per-node（实测阻断）
codex 出站调 `commhub_*` 工具靠 MCP，鉴权是 `bearer_token_env_var`——**读进程环境变量**，进程级。一个 app-server = 一套环境 = **所有 thread 共享同一个 ntok = 同一个网络身份**。
- 实测：`thread/start` 里传 per-thread `config.mcp_servers.commhub.bearer_token`（字面 token）→ 被拒 `-32600 invalid request`。codex 当前只认 env var 形式，不认 per-thread 字面 token。
- 后果：共享 app-server 下，各节点的 codex 出站（send_task/report 等）会**用同一个身份**，节点身份混淆。
- 注：入站（SSE/inbox）不受影响——那是每节点自己的桥（agent-node）持自己的 ntok；受影响的只有 codex 主动调工具的出站身份。

### 3.3 并发吞吐 + 配置爆炸半径
一个 app-server 串行 / 调度 N 条 thread 的并发 turn，吞吐是否够、有无全局锁瓶颈，需压测。且任何配置变更 / 崩溃 / 升级影响全部节点。

## 4. 内存实测

| 项 | idle 内存 |
|---|---|
| 一个 codex app-server（node 壳 + musl 引擎）| ~200–240MB |
| 桥（agent-node adopt）| ~100–150MB |
| 人类 TUI（codex resume --remote）| ~200MB（多为空闲）|

每个 co-presence 节点 ≈ 500MB；owned 节点 ≈ 300MB（省掉 TUI 那份）。

## 5. 推荐：不是"共享一个"，而是"分层 + 按需"

共享单 app-server 因 **3.1 SPOF + 3.2 身份进程级** 现阶段**不推荐**用于多身份多节点。省内存的正解是分层：

1. **每节点独立 app-server（现状，保留）**：可靠（故障隔离）、per-node 身份 / cwd 正确。这是生产基线。
2. **worker 用 owned 模式**：还是每节点一个 app-server，但**不挂人类 TUI**，省掉那 ~200MB/节点。大多数"牛 / 设计号 / 助手"走这条。
3. **重点节点（负责人 / 副责人 / TM 全部 / 你要交互的）用 co-presence**：多一个可 attach 的 TUI。
4. **按需启停**：闲置节点可停 app-server，来任务时再拉起（牺牲首 turn 冷启动 ~3s，换常驻内存）。

预算：约 20 个 co-presence（~8GB）+ 约 28 个 owned（~7GB）≈ 15GB，机器现有 ~28GB 可用，够，但要**分批上 + 盯内存**，剩 <5GB 就停。

## 6. 若将来真想「一机一 app-server」极致省内存

需要 codex 补两件事（当前 feature gap）：
- **per-thread MCP 字面 token**（不走进程 env），让每条 thread 带自己的 ntok；或
- **本地 MCP proxy**：一个 sidecar 持各节点 ntok，按调用来源 thread 路由到对应身份（复杂、也是 RFC-030 §4 提过的最小权限代理思路）。
在此之前，共享单 app-server 只适合「所有 thread 可共用一个身份 + 一个 cwd」的场景，不适合 48 个各自独立身份的团队角色。

## 7. 结论

- **一机一 app-server 装所有节点：不可靠**（SPOF + 身份进程级），不推荐做多身份多节点。
- **生产基线：每节点独立 app-server**；靠 **owned（worker）/ co-presence（重点）分层 + 分批 + 盯内存 + 按需启停** 控制内存。
- 极致省内存需 codex 支持 per-thread token 或本地身份路由代理，属后续增强。
