# agent-node v2.5.0-preview.45

本版从 main 发布，带出 preview.44 之后合入的两个改动：

- **#1408**（grok 共存）：人类在共存 TUI 里打一条干净的 `/model <id>` 现在会被**代为执行**（按键仍取消、斜杠面板零攻击面，带外走既有 `switchModel()` 受护入口，结果直接答在 TUI）；`/always-approve` 等安全拦截逐字未变。
- **#1406**（#1399 根治）：安装后兜底修复 node-pty `spawn-helper` 执行位，消除每次 npm 解包后 `posix_spawnp failed` 的复发。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.45
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.45
# 验证
agent-node --version   # 期望 2.5.0-preview.45
```

Grok 共存节点升级后，在共存 TUI 里 `/model <模型名>` 即可直接换模型；仍可用 `anet grok model <node> <model>` 从另一终端切换。

## Verification

- slash-gate 18/18、runtime 66/66、composer-tainted + allowlist-near-miss + model-switch 50/50（本地 bun test，见 #1408）
- 五格门合并至 main（commit b0c1ef3a）
