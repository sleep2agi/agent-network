# agent-node 2.5.0-preview.89

`.88` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 62cb1e8b | #2008 | opencode 任务截止时间可配置:`OPENCODE_TIMEOUT_MS` → `flags.timeout` → `flags.opencodeTimeoutMs` → 默认 **30 分钟**(原为写死 5 分钟,无法配置);`0` = 不限。共存模式超时后如实回复「任务仍在节点 TUI 里继续运行、未被中止」,不再回一条误导性的「错误」;headless 路径同样可配 |

现场依据:一个 opencode 共存节点接到真实长任务(拉仓库、写 CI、跑 docker build),5 分钟整被判「超时」,而任务在 TUI 里继续跑完。实测:超时只停止等待,不中止会话。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.89
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.116 @sleep2agi/agent-node@2.5.0-preview.89
```

🔴 **两个包要一起升**(`.116 ↔ .89`);hub `commhub-server@0.9.0-preview.60` 不变。

## 证据

- 新增测试(假 opencode serve 保持 busy):截止生效、回复文案、不发 abort、`0` 关闭、优先级与默认值;12 种变异全部变红。agent-node 全量 2041 pass / 0 fail;typecheck 棘轮 81 = 基线。

## promote 时的 must_contain

`"version": "2.5.0-preview.89"`
