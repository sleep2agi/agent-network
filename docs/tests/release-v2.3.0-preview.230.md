# agent-network 2.3.0-preview.230

Since `.229`: 只改配对常量，指向 agent-node `2.5.0-preview.198`（该运行时修好排队路径的未声明状态，
并守住可选写入器）。

## Why

`.229` 钉住的 `.197` 里，排队逻辑只有引用没有声明，走到忙分支会抛 `ReferenceError`。
`.198` 补齐状态与 `waitUntilIdle`，并在应用前确认写入器存在。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.230 @sleep2agi/agent-node@2.5.0-preview.198
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.198` 精确配对。

## What it does not do

- CLI 侧没有任何行为变化，只改配对常量
