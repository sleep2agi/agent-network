# `@sleep2agi/agent-network@2.3.0-preview.91`

## 为什么发这一版:两处真机事故的修复(#1872、#1876)

`.90` 之后 `agent-network/bin|src` 合入:

| 提交 | PR | 内容 |
|---|---|---|
| main after #1872 | #1872 | 共存身份回收器只认本节点进程树:继承了 marker 的外来进程(如从共存 TUI 里重启过的 pm2 及其子进程)只报告不杀(2026-09-14 生产 hub 被误杀 2 次) |
| main after #1876 | #1876 | claude-code-cli 节点回复附件:`attachments` 传成 JSON 字符串不再静默丢失;回复正文里的本机文件链接自动上传成附件;节点项目目录纳入 `commhub_upload_file` 受控根 |

## 这一版带给用户什么

- claude-code-cli 节点(如 外部团队节点)给人发文件:回复里写 `[名字](/绝对路径)` 即可,自动变附件卡片;`commhub_upload_file` 接受项目目录里的文件;把附件写成字符串也不再丢。
- `anet node codex restart` 不会再把碰巧继承了节点标记的无关进程当上一代杀掉。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.91
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.91
anet node stop <name> && anet node start <name>      # claude-code-cli 节点要重启才加载新的通道代码
```

## 边界

- 配对 agent-node 仍为 `2.5.0-preview.69`(agent-node 本版未动)。
- 只影响 anet 自身与它启动的 claude-code-cli 通道(node-server);其它运行时行为与 `.90` 逐字相同。
