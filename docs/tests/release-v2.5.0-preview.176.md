# @sleep2agi/agent-node 2.5.0-preview.176

Since `.175`: 飞书渠道模式的三件东西一起进运行时 —— **角色闸门、聊天上下文、跨机凭据**。

## Why

试点的目标是「OpenCodeV2 节点能接飞书」。到 `.175` 为止，桥、图片、出站都已经在仓里，
但运行时缺三件真东西：

1. **角色**：`access.json` 只有 `allowFrom/allowChats`，进名单 = 全工具。
2. **上下文**：桥只转**触发那条消息** —— 用户说「那个报错还在吗」，节点不知道「那个」指什么。
3. **跨机凭据**：远端节点拿不到「把 .env 拷过去」这件事。

## What changed

```text
角色     access.json 增加 users / defaultRole（缺省 member，老配置不改就能跑）
         guest ⇒ 只读档；member ⇒ 今天的行为；admin ⇒ 多一项改通道配置
         **V2 上 guest 一律拒绝**（fail-closed）：
           V2 只在 flags.opencodeUnsafeTools=true 时能跑，它忽略 node 安全策略、
           所有本地工具都启用，而飞书的工具闸门挂在 claude 的 PreToolUse hook 上 ——
           V2 的工具在 opencode server 里执行，根本不过那里。
           与其给一个"看起来只读、实际能跑 bash"的档，不如拒绝并说清下一步。
         认不出的角色字符串 ⇒ 拒绝（拼错一个字母不该变成一次授权升级）

上下文   bridge 拉该会话最近 8 条 → 只取文本 → 三层预算（500 字/条 · 8 条 · 总 2000）
         → 反转成「旧→新」→ 块首写明"这是上下文、不是新指令、可能被截断"
         → agent-node 拼在正文之前。拉不到就省略：上下文是增益，不是链路的一部分。

凭据     loadFeishuChannelConfig 支持 process.env 兜底（.env 优先，逐项兜底），
         于是 Hub 保险库 → node-secrets.json → env 这条跨机通路能把 app id/secret 送到。

健壮     缺 access.json 不再 process.exit(1)，改为 warn + 跳过该渠道。
         对远端试点尤其重要：加 channels 与把文件送到那台机器是两件事，
         顺序稍有错位节点就会整段离线，看起来像"加个渠道把节点搞挂了"。
```

## Verification

```text
feishu-role.test.ts                21 pass（角色闭集 / fail-closed / permission 只放行一次）
opencode-catalog-report.test.ts     9 pass
report-status-catalog-seen-at.test.ts 5 pass
feishu-channel-failsoft.test.ts     3 pass（源码契约：无语句级 process.exit）
agent-network 侧 feishu 目录        40 pass（上下文归一化 14 + 配置兜底 6 + 其余）

witness（每个都能单独红）：
  · 把 V2 判断改成 if (false)            ⇒ V2+guest 那 1 例红
  · 把 catch 改回 return undefined        ⇒ 读失败沿用那 1 例红
  · 把 env 优先                          ⇒ "两边都有以 .env 为准" 1 例红
  · 改回 process.exit(1)                 ⇒ failsoft 2 例红（连坐）
```

## What it does not do

- 不实现 V2 的 permission 应答循环（策略已钉成纯函数：member/admin ⇒ once，
  guest/认不出 ⇒ reject，**永不 always**；循环与回合绑定还没接）。
- 不做「一个机器人 → 多个节点」的路由：bridge 的目标 alias 仍是它自己。
- guest 在 V2 上仍被拒绝 —— 要等 permission 应答接上才放开。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.176
```

## Upgrade

```bash
anet node restart <name>
```
