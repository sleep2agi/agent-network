# agent-network (CLI) 2.3.0-preview.240

与 `@sleep2agi/agent-node` **2.5.0-preview.208** 精确配对。

## Why

`.208` 修的是**迟到回复的终态错误**：节点重启后会给「上次没等到结果」的原发送方补一条说明；
旧记录（没有 `to` 字段）只能靠 Hub 从 `tasks.from_name` 反查目标，任务行一旦被清理就反查落空，
Hub 返回 `reply_target_unresolved` ⇒ 这条说明**永远补不上**，而且每次重启重报一次
（本机实测 4 条旧记录，每次启动刷 4 行 warning）。现在把该错误视为终态，清掉记录并打一行说明。

修复在 agent-node 侧。CLI 这一版**没有行为变更**，只做版本对齐 —— `anet pair` 按
「CLI ↔ agent-node」精确配对给升级命令，少一边就会配错。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.240 @sleep2agi/agent-node@2.5.0-preview.208
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.208` 精确配对；单独升 CLI 不会带上迟到回复的修复，必须同时升节点。
