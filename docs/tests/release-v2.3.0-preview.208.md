# @sleep2agi/agent-network 2.3.0-preview.208

Since `.207`: 配对常量指向 agent-node `2.5.0-preview.176`（飞书角色闸门 / 聊天上下文 /
跨机凭据），并修掉一处**会把模式选错**的过期注释。

## Why

`bridge.ts` 文件头写着「CommHub task dispatch — **the default on any real node**」，
而代码里 `DEFAULT_FEISHU_BRIDGE_MODE = "direct"`。谁按注释选模式，就会以为自己走 Hub，
实际走的是本机直连 —— 排查时先看错一层。注释自己在下面还警告过"别留过期注释"。

## What changed

- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.176`
- `bridge.ts` 文件头的模式说明改成与代码一致：**默认 direct**（`ANET_FEISHU_BRIDGE_MODE=commhub`
  才走 Hub），并写清两条路的取舍与失败面
- 顶层 `--help` 的 Channel 段补上 `channel add feishu`（`.207` 已合，这里随版本重申）

## Verification

```text
bridge-mode.test.ts      6 pass（默认 direct；COMMHUB_URL 在场不改变模式；非法值抛错）
feishu 目录              40 pass
bun build bin/cli.ts     通过
```

## What it does not do

- 不动飞书协议层；不新增渠道类型。
- 多节点路由仍未实现（目标 alias 固定为桥自己）。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.208
```

## Upgrade

```bash
anet upgrade
anet node restart <name>
```
