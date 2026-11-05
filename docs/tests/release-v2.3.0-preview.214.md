# @sleep2agi/agent-network 2.3.0-preview.214

加一条**丢键告警**：保存 profile 时，磁盘上有、这次要写没有的键，打一行 warn。

## Why

`#3418` 查了三轮才找到的根因，本质是一句话：

```text
serializeProfileForConfigJson 是白名单；不在名单上的键会被静默写没。
而 config.json 里有一批键是**运行时写的**（如 opencodeConfiguredModelAtLastOpen），
只在 agent-node 里登记、不在启动器的名单里 ⇒ 每次 `anet node start` 都掉一次。
```

表现不是报错，是「下游读到 `null`，判据永远 false，谁也不知道少了一格」。
`.213` 补上了那一格；本版补的是**这一类**：以后再有键被丢，至少会喊一声。

## What changed

- `src/profile-merge.ts` 新增 `droppedProfileKeys(previous, written)`：纯函数，
  返回「磁盘上有、写出去没有」的键（值从有到无但键还在 ⇒ 不算丢；新键不算丢）。
- `bin/cli.ts` 的 `saveProfile`：写盘前对比磁盘现状，有丢键就 `console.warn`
  （一行，列出键名；不打印值 —— 值可能带凭据）。

## Verification

```text
profile-merge.test.ts  10 pass（新增 3 例）
  · 磁盘上有、写出没有 ⇒ 列出来
  · 值从有到无但键还在 ⇒ 不算丢（调用方主动删的）
  · 镜像否定：新键不算丢；磁盘为空/缺省也不算
```

## What it does not do

- 不阻止丢键（仍然是白名单），只是不再**静默**地丢。
- 不覆盖 `writebackOpencodeConfiguredModel` 这类直写路径（它们不经白名单，本来就不丢）。
- 生效需要一次 `anet node start`（新 CLI 才会打这条 warn）。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.214
```

## Upgrade

```bash
anet node restart <name>
```
