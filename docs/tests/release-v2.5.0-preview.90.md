# agent-node 2.5.0-preview.90

`.89` 之后 `agent-node/` 一个提交(`files: ["dist", "README.md"]`,改动在 `src/` → 打进 `dist/cli.js`):

| 提交 | PR | 内容 |
|---|---|---|
| 00bb9e79 | #2027 | opencode 共存:一轮对话在 **300 s 整点**以「opencode 错误: fetch failed」失败的修复(#2026)。OpenCode 的 `POST /session/:id/message` 直到本轮结束才返回响应头,而 Node 内置 fetch(undici)的 `headersTimeout`/`bodyTimeout` 默认 300 000 ms,无视 #2008 放宽到 30 分钟的任务截止。现在每轮用独立的 undici `Agent`,传输超时 = 任务截止 + 60 s 宽限(截止为 `0` 时不限),保证先触发的是桥自己的截止、继续走「任务仍在 TUI 里运行」的如实回复;Bun 下另传 `timeout: false`。传输失败的报错现在带上 undici 原因码(如 `UND_ERR_HEADERS_TIMEOUT`),不再只有一句 `fetch failed` |

`undici` 原本就是依赖(`^6.27.0`),由 `bun build --target node` 打进 `dist/cli.js`,不新增运行时依赖。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.90
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.117 @sleep2agi/agent-node@2.5.0-preview.90
```

🔴 **两个包要一起升**(`.117 ↔ .90`);hub `commhub-server@0.9.0-preview.60` 不变。

## 证据

- #2027:回归测试把生产模块按 `dist` 同样方式打包,在真实 `node` 子进程里跑(全局 dispatcher 的 300 s 缩到 1 s):正控证明计时器生效、`submit()` 仍拿到回复、每轮 Agent 超时跟随截止;三种变异各自变红。agent-node 全量 2042 pass / 0 fail;typecheck 棘轮 81 = 基线;test725(node:22)强制真 Node 运行。

## promote 时的 must_contain

`"version": "2.5.0-preview.90"`
