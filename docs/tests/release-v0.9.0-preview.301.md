# commhub-server 0.9.0-preview.301

Since `.300`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.301
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.301
```

## What changed

```text
#3889：Antigravity（agy）节点换模型走热切换。config-apply 校验只在「纯模型改动 + 节点自报
agy_hot_model_capable」时下发 hot，其余仍 restart；目录投影同步新模型。
与 agent-node@2.5.0-preview.234 / agent-network@2.3.0-preview.270 同步发版。
```

## Verified

```text
#3889 合入 main 1a13f4d3，100 项检查全绿；config-apply-validate / agy-catalog-projection 测试覆盖 hot 与 restart 分流。
```
