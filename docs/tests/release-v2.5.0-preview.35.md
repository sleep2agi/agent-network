# @sleep2agi/agent-node 2.5.0-preview.35 — release notes

这一版的主体是 **grok 共存的带外换模型**（#879）：以前换模型要在 TUI 里敲斜杠命令，
现在 attach 传输层带了控制角色，`set-model` 在有人 attach 的时候也能用，不经键盘。

配套还修了一个会打断人的缺陷：**控制连接断开不是人断开** —— 旧行为会把用户
打了一半的那一行清掉。

另外 opencode 共存的进程组身份在 macOS 上也有了。🔴 但请注意实现里那句注释：
`startTicks` 才是 PID 复用的唯一防线 —— 没有它，`process.kill(-pgrp, SIGKILL)`
可能杀掉一个不相干的进程组。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.48 @sleep2agi/agent-node@2.5.0-preview.35
anet node create
```

🔴 **配对版本是 2.3.0-preview.48，不是 .47。** `.47` 内置的
`PAIRED_AGENT_NODE_VERSION` 还是 `2.5.0-preview.34`，和本版配不上 ——
会报 `exact paired package identity validation failed`。这一点是 `.35` 发到
preview 后的真实环境烟测抓到的，本文首发时写的是 `.47`,已更正。

🔴 **两个包都要装。** agent-node 的包里没有飞书桥的代码（它去 fork
`@sleep2agi/agent-network` 的 `dist/src/im/feishu/worker.js`），单装 agent-node
时飞书通道只打一行 warn 就被跳过，节点照常起来 —— 静默降级。

`anet node create` 里选 grok 共存的 runtime，然后 `anet node start <name>`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.35
anet node stop <name>
anet node start <name>
```

配对关系是**精确版本**，不是范围：`agent-network` 会校验解析到的 agent-node 包的
`package.json` 版本严格等于它内置的 `PAIRED_AGENT_NODE_VERSION`。不等就拒绝启动，
报 `exact paired package identity validation failed`。所以升 agent-node 时要确认
手上的 agent-network 是配对的那一版。

## 本版包含

- `c98e0ae9` grok 共存：带外换模型，不经键盘（#879）
- `bedf3dec` grok 共存：attach 协议加 `set-model` 帧
- `18ea97bf` grok 共存：attach 传输层加控制角色，有人 attach 时 `set-model` 可用（#879）
- `f7c2cf9e` grok 共存：控制连接断开不是人断开 —— 不再清掉人打了一半的行
- `f94fa9d0` grok：hot switch 模型，失败再回退到重启
- `63aa3920` opencode 共存：macOS 上也有进程组身份（`startTicks` 是 PID 复用的那道防线）
- `3d6f678e` 测试：控制连接的断言留在它该在的层，不塞进 PTY 集成测试

## Verification

- `agent-node --help` 广告 `codex-app-server` 与 `opencode-cli`
  —— 这正是 agent-network 运行时用来判定配对包能力的两个谓词
  （`agentNodeHelpSupportsCodexAppServer` / `agentNodeHelpSupportsOpencode`）
- 安装路径烟测（Docker `node:24-slim`，与 CI 同镜像）：装全局 tarball 后
  版本 == `2.5.0-preview.35`、`agent-node` bin 在 PATH 上、两项能力都在 help 里
- witnessed-red 两条：版本喂 `.99` → `version mismatch`；help 不广告能力 →
  `配对启动会在用户机器上失败`

## 已知不支持

- **grok-build-cli 拒绝飞书通道**：fork 出来的 worker 日志边界没做凭据隔离，
  硬退并提示改走 CommHub inbox（`agent-node/src/cli.ts:1021`）。这是安全决定，
  不是未完成项。
- **claude-code-cli 不是 `--runtime` 的取值**：它由 `anet node start` 启动，
  不经 agent-node，因此没有本文所述的 IPC think() 路径。
