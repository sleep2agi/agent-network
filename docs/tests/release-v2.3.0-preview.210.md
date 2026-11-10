# @sleep2agi/agent-network 2.3.0-preview.210

Since `.208`: 配对常量指向 agent-node `2.5.0-preview.177`（飞书入站队列的 /q /cancel /prio /clear）。

## Why `.210` rather than `.209`

`.209` 的 publish 步骤**报告成功**，但 2700s 后 registry 上仍看不到该版本
（`dist-tags.preview` 停在 `.208`），两小时后复查依然不存在。
这类"publish 返回成功、制品不存在"的状态，重发同号会撞上"已存在"的歧义，
所以直接跳号重发 —— 让版本号与制品一一对应，不留一个"说不清发没发"的号。

## What changed

- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.177`
- 无其它行为改动

## Verification

```text
feishu 目录 45 pass · bun build bin/cli.ts 通过
发后核实：直读 registry 看到 2.3.0-preview.210 且 shasum 与本地 tarball 一致
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.210
```

## Upgrade

```bash
anet upgrade
anet node restart <name>
```
