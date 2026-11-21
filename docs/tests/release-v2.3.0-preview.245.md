# agent-network (CLI) 2.3.0-preview.245

与 `@sleep2agi/agent-node` **2.5.0-preview.212** 精确配对（本版不动配对，只改提示）。

## Why

**`anet pair` 补一行说人话的 Node 版本提示**（负责人 2026-11-22）。

npm 的 `EBADENGINE` 只是裸警告：它说「engines 不满足」，但不说「会怎样」。本版在
`anet pair` 里检测当前 Node 版本，低于 `engines` 要求的 `22.13.0` 时打印：

```text
[anet] ⚠️  当前 Node v20.20.0 低于本包 engines 要求的 22.13.0 —— 建议升级到 ≥22.13.0，
        否则可能有不明确的行为差异（本次不阻断）。
```

**不阻断**任何操作；`--json` 输出多一个 `nodeEngineWarning` 字段（满足时是 `null`）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.245 @sleep2agi/agent-node@2.5.0-preview.212
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```
