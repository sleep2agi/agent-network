# agent-node 2.5.0-preview.222

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.256** 精确配对。

## Why

**回合控制能力位与「停止」实现**（`#5332` ③ 三步全部落地）：

```text
claude（默认 runtime）  #3786  复用已有 AbortController ⇒ 停止可用；插话仍不支持（SDK query() 无同轮注入）
codex-app-server        #3788  bridge 增加 turn/interrupt ⇒ 停止可用
ACP（antigravity / grok）#3789  session/cancel 通知 ⇒ 停止可用（同时覆盖 grok ACP）
能力位：turn_interrupt_capable = opencode V2 共存 ∥ claude ∥ codex-app-server ∥ ACP
        turn_steer_capable    仍只有 opencode V2 共存
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.222 @sleep2agi/agent-network@2.3.0-preview.256
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

```text
· 真机：agy 节点 working 时点「停止」是否真的 cancelled（老版本 agy 可能不认 session/cancel；
  若不认，按版本降级能力位或固定 false）
```
