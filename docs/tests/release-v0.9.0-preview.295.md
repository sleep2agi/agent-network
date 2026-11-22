# commhub-server 0.9.0-preview.295

Since `.294`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.295
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.295
```

## What changed

```text
#3778（#5332）回合控制能力位：report_status.config_snapshot 收 turn_interrupt_capable / turn_steer_capable，
        /api/nodes 每行投影（未上报为 null，客户端据此走白名单兜底）
        只有真具备通道的 runtime 才为 true（当前：OpenCode V2 共存）
```

## Verified

```text
turn-capabilities-projection 2 pass；回归 tool-audience-http 13 pass、api-nodes-shape 10 pass
```
