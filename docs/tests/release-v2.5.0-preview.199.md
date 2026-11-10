# agent-node 2.5.0-preview.199

Since `.198`: daemon 接管时用节点自己的凭证证明「同一个 Hub」，不再比对 URL 文本（#3488）；
source 投递中止时保留真实原因（6820fa9d）。

## Why

vdev 上 daemon 必须用 `https://y.vansin.top`（source fork 通道拒绝非本机 http），手动起的节点用
`http://y.vansin.top:9300`。同一个 Hub、两个地址，接管一律 `adopt_hub_mismatch`。现在地址不同时，daemon
拿节点 token 问自己的 Hub `/api/auth/me`，Hub 认出是同一 network + alias 的节点凭证才接受；证明过的地址
记进接管登记（`proven_hub`）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.231 @sleep2agi/agent-node@2.5.0-preview.199
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.231` 精确配对。

## What it does not do

- 不改节点配置，不重启已运行的节点；只影响 daemon 的接管核验
