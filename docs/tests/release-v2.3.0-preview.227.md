# agent-network 2.3.0-preview.227

Since `.226`: 新增 `anet pair`，并把「半对安装」从根上堵住。

## Why

两个包的 `preview` 标签**先后**移动（先发 agent-node，再发声明它的 CLI），
所以「两边都 @preview」在窗口期里会装出**不配对的一半**。配对判据是 **CLI 包里的常量**，不是 tag。

## What changed

```text
anet pair [--json]    打印 CLI 版本、精确配对的 agent-node spec、以及唯一一条安装命令
bin/cli.ts            启动 agent-node 时传 ANET_LAUNCHED_BY_CLI_VERSION（3 个真实 spawn 点）
docs-site 安装页       preview 段改为「只装 CLI → anet pair → 照它打印的那行装 node」
```

`opencode-cli` 这条路径**禁用了自动 npx**，目标机上必须有精确版本的全局 agent-node，不会被自动替代 ——
所以「照 anet pair 打印的那行装」是唯一不用猜的做法。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.227 @sleep2agi/agent-node@2.5.0-preview.195
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.227 @sleep2agi/agent-node@2.5.0-preview.195
```

⚠️ 与 agent-node `2.5.0-preview.195` 精确配对。

## What it does not do

- `anet pair` 不探测「当前装了什么」，只回答「应当装哪一对」（探测会引入新的失真来源）
