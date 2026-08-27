# @sleep2agi/agent-network 2.3.0-preview.49 — release notes

这一版只做一件事：**修正飞书出站传输的默认路径**。`.48` 不要升 latest，原因见下。

## `.48` 里发生了什么

`2.3.0-preview.48` 打包时的 main 含 #1252（飞书回复走 CommHub 任务分发）、
不含 #1262（把选路改成显式声明）。于是已发布的 `.48` 里的选路是：

```js
process.env.COMMHUB_URL || process.env.ANET_HUB_URL   // 有 hub 地址就走 commhub
```

每个真实节点都设了 hub 地址 ⇒ **`.48` 上启用飞书的节点默认走 CommHub** ——
与 2026-08-27 指挥室的明确决定（默认非 commhub）相反。
证据是已发布 tarball 的字节：worker.js（minified）里含该选路串与 `in_reply_to`。

## 本版（`.49`）的行为

```ts
export type FeishuBridgeMode = "commhub" | "direct";
export const DEFAULT_FEISHU_BRIDGE_MODE = "direct";
```

- 默认 `direct`：bridge → parent IPC → `think()`，**不进 CommHub 任务分发**，
  也不出现在 Dashboard 拓扑 / Chat
- `commhub` 必须显式 `ANET_FEISHU_BRIDGE_MODE=commhub` 打开
- **设了 `COMMHUB_URL` / `ANET_HUB_URL` 也不改变模式**
- `commhub` 模式拿不到客户端硬退，不悄悄回落；写错值直接抛

七条单测守着（`bridge-mode.test.ts`），三个变异各被对应一条抓住。
文档见 guide/feishu.md §8.4。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.49 @sleep2agi/agent-node@2.5.0-preview.35
anet node create
```

🔴 **两个版本必须成对**：本版内置 `PAIRED_AGENT_NODE_VERSION = 2.5.0-preview.35`，
共存路径按精确版本校验，不等则拒绝启动。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.49 @sleep2agi/agent-node@2.5.0-preview.35
anet node stop <name>
anet node start <name>
```

从 `.48` 升级：若你显式依赖了"有 hub 地址就走 commhub"的行为，
现在要改设 `ANET_FEISHU_BRIDGE_MODE=commhub` —— 静默依赖不再成立。

## 本版包含（相对 `.48`）

- `f682d9d3` feat(feishu): 出站传输模式显式声明，默认 direct（#1262）
- `5b1b402c` test(feishu): 模式解析的七条单测（变异验证过）
- `5c61ee5b` feat(feishu): 回复走 CommHub 任务分发（#1252，现在是**可选模式**）
- 版本位 4 处由 `scripts/sync-pinned-versions.sh` 一次改全

`.48 → .49` 对 `agent-network/` 的全部改动只有 feishu bridge 与其测试 ——
引导密码等 getting-started 断言的代码路径未被触碰。
