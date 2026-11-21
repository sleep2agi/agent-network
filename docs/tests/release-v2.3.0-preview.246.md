# agent-network (CLI) 2.3.0-preview.246

与 `@sleep2agi/agent-node` **2.5.0-preview.212** 精确配对（本版不动配对）。

## Why

**修 `.245` 的重复提示**：`anet pair` 会先由启动层（`anet.cjs`）打一条 Node 版本警告，
再由命令自身补一条同义提示 —— 用户看到两条。现在统一由启动层打**一次**，措辞按负责人要求：

```text
[anet] ⚠️  当前 Node v20.20.0 低于本包 engines 要求的 22.13.0 —— 建议升级到 >=22.13.0
        （nvm install 22），否则可能有不明确的行为差异（本次不阻断）。
```

`anet pair --json` 仍带 `nodeEngineWarning` 字段（满足条件时为 `null`），脚本化调用不丢信息。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.246 @sleep2agi/agent-node@2.5.0-preview.212
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```
