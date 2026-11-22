# agent-node 2.5.0-preview.219

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.253** 精确配对。

## Why

**「CLI 在等一个选项」的信号接通了**（只读观测，不改任何 runtime 行为）：

```text
· 检测源：我们自己 spawn 的子进程 stderr —— agy / grok-build-acp / grok-build-cli 三条路径
· 检测到已知固定短语（codex_update / codex_trust / claude_trust / opencode_update / login_required）
  ⇒ 写进 report_status.config_snapshot.interactive_prompt，Hub 投影为 /api/nodes 的 prompt_pending
· 首条命中打一行 warn；同类重复不刷屏
· **生命周期**：一轮任务正常拿到回复时清除（四条成功 return 点）；
  超时/异常不清（那时显示「在等选项」是对的）
· 摘录脱敏（控制字符 / ntok_ / sk- / ghp_ 抹掉，截 200）
```

Hub 侧 `.293` 已上线（schema + 投影，权限与 workdir 同一套：看不见节点就看不到该字段）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.219 @sleep2agi/agent-network@2.3.0-preview.253
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未覆盖

```text
· codex 的 update prompt 在 TUI 进程里，app-server 侧拿不到 ⇒ 单独开卡（不在本版）
· opencode-server 没有稳定的 stderr 回调面 ⇒ 本版未接（需要时单独开卡）
· 真机 prompt_pending 有值：等某台 agy/grok 节点触发一次未登录/信任类提示
```
