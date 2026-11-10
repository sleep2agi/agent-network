# @sleep2agi/agent-network 2.3.0-preview.207

Since `.206`: 写 profile 时**只写声明的那几格**，不再用内存里的旧快照整份覆盖。

## Why

2026-11-01 生产实测（通信欧 `n_28e6b2c2`）：

```text
[17:14:43] [config-apply] OpenCode V2 session model=xai/grok-4.7 (no restart, .prev backedUp=true)
           Hub: applied；sessions.model=xai/grok-4.7 连续 48s 稳定
[18:25:06] 节点重启，读到的 config.json 里 model 已经是 deepseek/deepseek-flash
```

长命进程（共存桥）在内存里握着**启动时读到的** profile。它后来只想记一格
`opencodeMode: "copresence"`，却把整份 profile 写回去 —— 期间 Hub 改过的 `model`
被一起抹掉。写的人没有恶意，是「写整份」这个动作本身带上了所有旧值。

## What changed

新增 `src/profile-merge.ts`（纯函数）+ `bin/cli.ts` 的 `patchProfileFields(id, patch)`：
以**磁盘当前内容**打底，patch 覆盖它。三个「只记一格」的调用点改用它：

```text
opencodeMode: "copresence"      （共存启动）
grokCopresenceAuto: true        （记住 grok 共存）
codexCopresence / FullAccess    （记住 codex 共存与全权）
```

读不到磁盘就不写：宁可少记一格，也不要用读不懂的旧值覆盖整份文件。
`create` / `edit` 这类**有意整份写**的路径不变。

## Verification

```text
src/profile-merge.test.ts                     4 pass
  · patch 只给 opencodeMode ⇒ 磁盘上的 model（Hub 改过的）必须原样保留
  · 镜像：patch 显式给 model ⇒ 才允许改（那是意图，不是快照）
  · 不丢其它键（token / node_id / runtime 仍在）
src/opencode-copresence-cli.test.ts          13 pass
  · 两条次序判据改成看 patchProfileFields（**次序不变**：生成策略拒绝必须先于任何写入）
witness：把那处改回 saveProfile(resolved.id, profile) ⇒ 次序两例红（reds=2，连坐）
bun build bin/cli.ts 通过
```

## What it does not do

- 没有证明这一处就是那次 model 被抹掉的**唯一**写者 —— 只证明它属于「整份回写」这一类，
  且已消除。要钉死写者需要给每个 config.json 写入点加 `[config-write] source=… model=…` 日志
  （下一张卡，#3418 的续）。
- 不改 agent-node；bin 里的 pair 仍是 `agent-node@2.5.0-preview.171`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.207
```

## Upgrade

```bash
anet node restart <name>
```
