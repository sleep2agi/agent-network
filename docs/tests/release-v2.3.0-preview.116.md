# `@sleep2agi/agent-network@2.3.0-preview.116`

`.115` 之后 `agent-network/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| a5a898e9 | #2011 | 新建 Grok 节点默认 headless ACP(`--runtime grok` → `grok-build-acp`);`--runtime grok --copresence` 显式选实验性共存 TUI(`grok-build-cli`);`grok-build-acp --copresence` 拒绝并提示正确写法。创建菜单 / `anet setup` / `anet --help` 标 ACP 为默认、共存为实验性并列出已知限制;已有 `grok-build-cli` 配置不受影响 |

另:`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.89`(opencode 任务截止可配,#2008)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.116
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.116 @sleep2agi/agent-node@2.5.0-preview.89
```

🔴 **两个包要一起升**(`.116 ↔ .89`)。

## 证据

- `grok-create-mode.test.ts` 14/14,5 种变异各自变红;agent-network 全量 1325 pass / 0 fail;配对测试红→绿;doc 门 rc=0。

## promote 时的 must_contain

`"version": "2.3.0-preview.116"`
