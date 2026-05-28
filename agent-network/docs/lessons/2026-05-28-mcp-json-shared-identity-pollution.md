# 典型失败案例：grok-build-acp 共享 .mcp.json 导致多节点身份污染

**日期**: 2026-05-28（北京 03:35-04:02）
**Issue**: [#203](https://github.com/sleep2agi/agent-network/issues/203) + [#204](https://github.com/sleep2agi/agent-network/issues/204)
**触发**: Vincent UAT — 同一项目目录下新建节点 grok测试5 但消息显示 from = grok测试员（老节点）
**Lead 复盘**: 通信龙

## 现象

Vincent 在 `/home/vansin/grok-build/` 目录下：
- 已有 grok测试员 节点（已停止运行）
- 新建 grok测试5 节点（fresh `anet node create`）
- 启动 grok测试5，发消息出去

期望：from = `grok测试5`
实际：from = `grok测试员`（老节点 alias）。LLM agent 自己也声称"我是 grok测试员"。

## 我们怎么 3 次 jump to conclusion 都错了

### 错误诊断 1：客户端 config 污染
通信龙第一反应：grok测试5 的 config.json 里 alias 字段被错写成 grok测试员。

**自查后排除**：cat 两份 config.json — 都干净，node_name/token/ntok 完全独立无撞车。

### 错误诊断 2：hub server ntok→label 映射错乱
通信牛 audit 后排除：hub DB 里两个 token label 完全正确，旧 ntok→`node:grok测试员`、新 ntok→`node:grok测试5`，无错位。

但发现：错消息时间窗里**用的是旧 ntok**（不是新 ntok），所以 hub 写库时按旧 ntok 标签写就出现 grok测试员。通信牛 ship 防御性 fix bf564fb：from_session 不一致直接 reject。

### 错误诊断 3：TMUX_NAME silent fallback
通信龙基于"agent-node 用旧 ntok"猜测：可能 node-server.ts:74 silent fallback 读 TMUX_NAME / hostname() 当 alias。SDK马 ship 4 层防御 commit 063181f：移除 silent fallback + loud warn + explicit COMMHUB_ALIAS。

**Vincent 一句话证伪**：grok测试5 根本没用 tmux 跑。
通信龙 ps -ef 自验：grok测试5 进程的 env 没 TMUX_NAME。

3 次诊断全错。

## 真 root cause

通信龙在 `/home/vansin/grok-build/` 项目根 grep "grok测试员"，找到 `.mcp.json`：

```json
{
  "mcpServers": {
    "commhub": {
      "command": "bun",
      "args": [".anet/node-server.ts"],
      "env": {
        "COMMHUB_ALIAS": "grok测试员",
        "COMMHUB_TOKEN": "ntok_fc200cca7fc445448d3e4ea795028588",
        "COMMHUB_RESUME_ID": "sdk-n_477f84c4"
      }
    }
  }
}
```

`.mcp.json` 是 **Claude Code / Grok CLI 项目级 MCP 配置**（不是 agent-node 控制的）。

调用链：
1. `anet node start grok测试5` → agent-node 启动，--alias grok测试5 ✓
2. agent-node grok-build-acp runtime → spawn `grok agent stdio` CLI，cwd = 项目根
3. Grok CLI 启动，**读 cwd 下 `.mcp.json`** 装载 MCP servers
4. ACP `session/new` agent-node 传 `mcpServers: []`（空数组），所以 Grok 走 fallback
5. commhub MCP server 被 spawn，env 全是 .mcp.json 写死的老身份
6. 所有 `commhub_send_task` 调用用老 alias/老 ntok 发出

agent-node 进程外层"知道"自己是 grok测试5，但**它 spawn 的内层 commhub MCP 通道用的是 .mcp.json 写死的老身份**。

## Vincent 4:00 北京点透的设计原则

> ".mcp.json 里面不能写死啊，一个文件夹下面会有多个 node 的"
> "~/grok-build/.anet/nodes/grok测试5/config.json 这个文件里面不是有 alias 吗？"

**单一身份源 = config.json**。agent-node 应该从 `~/<project>/.anet/nodes/<alias>/config.json` 读 alias / token / hub / resume_id，**通过 ACP 协议 `session/new` 的 `mcpServers: [...]` 主动注入**给 Grok CLI，根本不依赖 .mcp.json 文件。

`.mcp.json` 沦为单节点 / dev 模式的 fallback，多节点场景下被 ACP 注入覆盖。

## 为什么 claude-agent-sdk / codex-sdk 不受影响

这两个 runtime 不用外部 CLI（不读 .mcp.json），agent-node 直接通过 SDK 库调用，MCP 服务器是 agent-node 自己 spawn 的子进程，env 在 spawn 时按当前 --alias 注入。每个节点一个 agent-node 进程，互不污染。

只有 grok-build-acp runtime 因为依赖 Grok 外部 CLI（类似 Claude Code，自己读 .mcp.json）才中招。

## 教训 / 防御启发

### 1. 多实例场景下，文件级配置 = 共享单例 = 必撞车

任何 `<project>/.<tool>.json` 形式的项目级配置文件，多个实例同时跑在同一项目目录下时**必然撞车**。设计 multi-tenant 时不能用文件做身份源——必须用 **per-process injection** 或 **per-instance config path**。

### 2. 自查 SOP — 重大 bug 优先 grep 项目根级 config 文件

通信龙 3 次错误诊断花了 ~25 分钟，最后是 `find /home/vansin/grok-build -type f -name "*.json" -exec grep -l "grok测试员" {} \;` 一行命令找到 root。

**新规则**：身份/attribution 类 bug 出现时，第一时间 grep `<project>/.{mcp,claude,grok,codex}.*` 文件是否写死了实例特定值。

### 3. 多 runtime 架构下要 audit 「是否有外部工具读项目级配置」

agent-node 三种 runtime：
- claude-agent-sdk: agent-node 控 env ✓
- codex-sdk: agent-node 控 env ✓
- grok-build-acp: Grok CLI 控 env via .mcp.json ✗（漏审）

新 runtime 接入时**必须 audit**：是否依赖外部 CLI、外部 CLI 是否读项目级配置文件、agent-node 能否覆盖。漏审 = 引入 multi-instance pollution 风险。

### 4. 三个 wrong theories 的 trail 是 over-confidence bias

通信龙第一次诊断"client config 污染"是没 grep config 就猜的；第二次 jumping 到 TMUX_NAME 是没看 env 就猜的。每次都立 issue + dispatch fix，浪费了 SDK马 / 通信牛 ~30min 写防御补丁。

**新规则**：dispatch fix 前必须 validate root cause（至少 grep 一遍涉及的配置 / env / state 文件）。jumping to conclusion + dispatch = 给团队产生 noise + 浪费 review。

### 5. Vincent push back 的速度比团队自我纠错快

Vincent 用 1 句话（"grok测试5 我都没开 tmux"）证伪了我精心准备的 TMUX_NAME 理论，比我自己 audit env 还快。Vincent 知道他的实际操作历史，是 ground truth source。

**新规则**：拿到 Vincent UAT 报告时，第一时间问"你具体怎么跑的 / 之前怎么操作的"，不要凭推理跳到 root cause。

## Fix 落地（追踪 #204）

- 派 通信SDK马 改 `src/runtime/grok-build-acp/runtime.ts` 让 `session/new` 注入 commhub MCP 配置（来自 config.json）
- 验收：Docker 2 grok-build-acp 节点同 cwd，from attribution 独立无污染
- 落地后写进 [[playbook]] 防御 SOP：grok runtime 节点启动必 ACP 注入 commhub

## 关联

- #194 dual-fix（from-name attribution）
- #203 dual-lane defense（send-side + hub-side）
- #204 真 root cause fix（grok ACP injection）

#194 #203 #204 是一条 attribution bug chain — 同一个 from-name 问题在不同层级出现 3 次。每次都 partial fix，每次都漏一层。**根本设计问题**：commhub MCP 身份没有 single source of truth。#204 ship 后这条链才闭环。
