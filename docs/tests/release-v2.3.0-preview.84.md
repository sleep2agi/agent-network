# `@sleep2agi/agent-network@2.3.0-preview.84`

## 为什么发这一版:起节点优先用装在 anet 旁边的 agent-node(#1808)

`.83` 之后 `agent-network/bin|src` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `27d3d153` | #1813 | **#1808** —— `anet node start` 解析 agent-node 时,在 `ANET_AGENT_NODE_BIN` 之后、PATH 之前加一层「与 anet 同一个 `node_modules` 里的 agent-node」;PATH 那一层的日志打印实际解析到的路径 |

| 用户看到的 | `.83` | `.84` |
|---|---|---|
| 隔离前缀 / 多棵 node 树里 `anet node start`(grok 或默认 runtime) | 用 PATH 上另一棵树的老 agent-node(真机:.40 在占位文件上崩) | 用和 anet 一起装的那份,日志第二行写出路径与版本 |
| 全局安装 | 同一份(PATH 与旁边是同一个文件) | 同一份,行为不变 |

配对 agent-node 仍为 `2.5.0-preview.65`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.84
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.84
```

## 证据

- `sibling-agent-node.test.ts` 7 条;`bun tsc --noEmit` 0 错;agent-network 单测全绿;test225(grok 预览包真机套件)绿(日志契约句保留)。
- PR #1813 在 main 上 109 项检查全绿(2026-09-04;report-only 一次 qa-cli-02 flake 重跑绿,见 #1593)。

## 边界

- codex / opencode 的解析本就按精确配对版本扫 PATH,本版不动。
- 真机回验:DEV `~/anet-preview/node_modules/.bin/anet node start grok-v1`(不带 PATH 前缀)应打印 `beside anet: …/agent-node/dist/cli.js (2.5.0-preview.65)`。

## promote 时的 must_contain

`"version": "2.3.0-preview.84"`(闸 4 对整个 `package/` 目录 `grep -rq`,命中 package.json;`.83` 产物 0 命中)。
