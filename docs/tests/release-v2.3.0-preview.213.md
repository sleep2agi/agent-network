# @sleep2agi/agent-network 2.3.0-preview.213

修一处**白名单丢键**：`opencodeConfiguredModelAtLastOpen` 不在 profile 序列化白名单里，
于是每次 `anet node start` 保存 profile 时都被静默丢掉。

## Why（这次是拿到了真值才修的）

`.179` 在打开共存运行时前打印了判据的三格输入，生产实测：

```text
[opencode] reconcile inputs model="xai/grok-4.7" marker=null generation="v2" resume="ses_…" decide=false
```

`marker=null` —— 而磁盘上那一格是 `""`。差在**中间有人把它丢了**：

```text
1. agent-node 运行时把 marker 清空成 ""（想触发对账）
2. 下一次 `anet node start` → patchProfileFields → saveProfile
   → serializeProfileForConfigJson（白名单，只写名单内的键）
3. marker 不在名单里 ⇒ 被丢掉 ⇒ agent-node 读到 marker=undefined
4. shouldReconcile = (typeof marker === "string" && marker !== model) = false
5. 走「保留会话模型」分支 ⇒ 永远不自愈
```

这也解释了为什么「同一份函数、同一个文件」在壳里返回 `true`、在进程里是 `false`：
壳读的是**磁盘**，进程读的是**启动器重写过的磁盘**。

## What changed

`serializeProfileForConfigJson` 白名单新增这一格，且**空串原样保留**
（空串是「要触发对账」的有效信号，不是「没配」）；从未有过则不凭空造。

## Verification

```text
agent-network/src/profile-merge.test.ts  7 pass（新增 3 例）
  · marker 为空串 ⇒ 原样保留
  · marker 有形值 ⇒ 原样保留
  · 镜像否定：从未有过 ⇒ 不凭空造（不能把 undefined 写成空串）
witness：从白名单删掉这一格 ⇒ 前两例红（同一丢键行为的两种形态，连坐）
```

## What it does not do

- 不改 agent-node 的判定逻辑（它一直是对的；是输入被丢了）。
- 生效需要一次节点重启（启动器要用新版才会保 key）。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.213
```

## Upgrade

```bash
anet node restart <name>
```
