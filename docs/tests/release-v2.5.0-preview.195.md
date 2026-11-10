# agent-node 2.5.0-preview.195

Since `.194`: 节点开始**自报「是哪一个 anet CLI 启动的我」**。

## Why

`config_snapshot.anet_version` 是静态占位值（`0.1.0`），节点**说不出**启动它的 CLI 版本。
于是客户端无法给出「这台主机该装哪一对」，只能提示 `agent-node@preview` 这类**单边**命令 ——
而 opencode-cli **禁用了自动 npx**，装到不配对的版本就会 `Incompatible agent-node for opencode-cli`
拒绝启动，节点掉线（#4412）。上一版修了配对写入链路；这一版补上「谁是启动者」这一格。

## What changed

```text
src/launched-by-cli-version.ts        读取 + 校验 ANET_LAUNCHED_BY_CLI_VERSION（semver / preview 形态）
src/cli.ts                            在 config.json 的 env 合并**之前**读取并随心跳上报
                                      config_snapshot.launched_by_cli_version
```

- **缺失或形状不对 ⇒ 一个键都不出**（不是 `null`，不是占位值）：编一个版本号比不报更坏，
  客户端会拿它拼出一条精确安装命令。
- 读取点在 profile env 合并之前，节点 profile 改不了「谁启动了我」。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.227 @sleep2agi/agent-node@2.5.0-preview.195
```

## Upgrade

```bash
anet pair          # 打印与当前 CLI 精确配对的那一行，照它装
```

⚠️ 与 CLI `2.3.0-preview.227` 精确配对。

## What it does not do

- 不改 `anet_version` 的语义（另一个含义，别的代码在读）
- 不猜版本：拿不到就整格不报
