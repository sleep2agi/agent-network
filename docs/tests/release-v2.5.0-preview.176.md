# @sleep2agi/agent-node 2.5.0-preview.176

<<<<<<< HEAD
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
=======
Since `.175`: 会话模型漂出配置后**武装一次对账**，下一次启动自愈。

## Why

判据读错了对象（生产实测，通信欧 `n_28e6b2c2`）：

```text
config.json  model = xai/grok-4.7
             opencodeConfiguredModelAtLastOpen = xai/grok-4.7   ← 相等
sessions     model = deepseek/deepseek-flash                    ← 实际在跑的

shouldReconcileOpencodeSessionModel(config, MODEL)
  = marker 存在 && marker !== MODEL  =  false
⇒ 走 else：keeping the resumed session's selected model
⇒ 配置说 xai、会话跑 deepseek，判据认为「一致」，永远不会自愈，也没有声音
```

根因：marker 记的是「上次打开时的**配置**」，判据却把它当成「上次打开时的**会话**」。

## What changed

- `profile-state.ts` 新增 `armModelReconcile(configPath)`：把 marker 清空。
  空串一定不等于任何真实模型名 ⇒ 下一次启动 `shouldReconcile` 必为真 ⇒ 强制对账一次。
  已经为空时返回 `false`（心跳不该整天改 config.json）；旧节点从未写过 marker 时不凭空造一个。
- `cli.ts` 的 `pollOpencodeSessionModel`：一旦观察到 `next !== MODEL`，
  且这还是一句「假话」（marker 非空），就清空 marker 并打一行 warn。
>>>>>>> 12e3a656 (fix(#3418): 会话漂出配置后武装一次对账，下一次启动自愈)

## Verification

```text
<<<<<<< HEAD
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
=======
profile-state.test.ts  10 pass
  · 清空 marker ⇒ 下一次启动必判差异
  · 已为空 ⇒ 返回 false（幂等，不重复写盘）
  · 镜像否定：旧节点没有 marker ⇒ 不凭空造
  · 接线：armModelReconcile 必须挂在 `next !== MODEL` 的条件里（守卫位置判据）
witness：把 armModelReconcile 改成什么都不做 ⇒ 2 例红（同一 marker 的两种断言，连坐）
>>>>>>> 12e3a656 (fix(#3418): 会话漂出配置后武装一次对账，下一次启动自愈)
```

## What it does not do

<<<<<<< HEAD
- 不实现 V2 的 permission 应答循环（策略已钉成纯函数：member/admin ⇒ once，
  guest/认不出 ⇒ reject，**永不 always**；循环与回合绑定还没接）。
- 不做「一个机器人 → 多个节点」的路由：bridge 的目标 alias 仍是它自己。
- guest 在 V2 上仍被拒绝 —— 要等 permission 应答接上才放开。
=======
- **不改变**「TUI 里手动切的模型在重启后仍保留」这条既有语义（`v2-session.test.ts` 钉着）：
  手动切之后 session 会漂离配置 ⇒ 现在会武装对账 ⇒ 下次启动**回到配置**。
  ⚠️ 这与旧语义相反，是本版唯一的行为变化，写在这里而不是埋在 diff 里。
- 不决定「配置 vs 会话」谁更高；它只是在发现两者不一致时，让下一次启动按配置执行。
- 生效需要一次节点重启（启动时才会读 marker）。
>>>>>>> 12e3a656 (fix(#3418): 会话漂出配置后武装一次对账，下一次启动自愈)

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.176
```

## Upgrade

```bash
anet node restart <name>
```
