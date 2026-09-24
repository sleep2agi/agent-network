# agent-node 2.5.0-preview.86

`.85` 之后 `agent-node/` 两个提交,都在 codex-app-server 运行时:

| 提交 | PR | 内容 |
|---|---|---|
| ff85f82e | #1988 | 新环境变量 `ANET_QUEUE_TIMEOUT_MS`:覆盖任务排队截止(默认仍 30 分钟;整数毫秒 1..2^31-1,非法值忽略并告警一次) |
| 98850599 | #1989 | 启动时恢复会话线程有自己的截止 `ANET_CODEX_RESUME_TIMEOUT_MS`(默认 120 s,原为通用 30 s),超时重试一次、不回退新线程;仍失败则先向 hub 报离线再退出,hub 不再把死节点显示成 idle |

现场依据:一台 rollout 约 950 MB 的节点,启动恢复在 24 s 与 >30 s 之间摇摆;旧版超时即 `exit(1)`,且发生在注册之后,hub 上残留 idle 约 9.5 分钟无人消费任务。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.86
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.113 @sleep2agi/agent-node@2.5.0-preview.86
```

🔴 **两个包要一起升**(`.113 ↔ .86`);hub `commhub-server@0.9.0-preview.57` 不变。

## 证据

- #1988:新增 12 条(去掉 env 读取即红);#1989:新增 10 条,7 种变异各自变红。agent-node 全量 1958 pass / 0 fail;typecheck 棘轮 81 = 基线。

## promote 时的 must_contain

`"version": "2.5.0-preview.86"`
