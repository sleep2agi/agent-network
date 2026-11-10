# agent-network 2.3.0-preview.216

Since `.215`: **对齐 daemon 环境清洗的两份清单**（#620），并把发布配对常量跟到
`agent-node 2.5.0-preview.182` / 自身 `2.3.0-preview.216`。

## Why（两份清单说"同表"，其实不同表）

`deploy/hub/hub-daemon.sh` 的 `_scrub_node_identity_env` 与
`agent-network/src/daemon-inherited-env.ts` 各有一份要清除的 session-identity 变量名，
两边靠一条 lockstep 测试对着。这条测试在 `anet QA` 里**第一次真正跑完**，就发现三处不一致：

```text
AGENT · AI_AGENT · OPENCODE · OPENCODE_* · COMMHUB_SESSION_ID
（shell 清了，TS 没清）
```

后果：经 `anet node start` 拉起的 daemon 会把它们带进**长期** environ。

## What changed

```text
daemon-inherited-env.ts
  · EXACT_NAMES 补 AGENT / AI_AGENT / OPENCODE / COMMHUB_SESSION_ID
  · PREFIXES   补 OPENCODE_
  · 仍**故意保留** provider 凭据（*_API_KEY）—— 见下

daemon-inherited-env.test.ts
  · lockstep 把「故意保留」写成数据：SHELL_ONLY = {"*_API_KEY", "*_API_KEY_*"}
  · 并且反向断言「登记为例外的，TS 确实没清」—— 否则那句注释就是假的
  · 顺手修了抽取器：旧正则会 `*_API_KEY` 切成 `API_KEY`（切错与真差异在断言里同形）

opencode-agent-node-pair.ts
  · PAIRED_AGENT_NETWORK_VERSION → 2.3.0-preview.216
  · PAIRED_AGENT_NODE_VERSION    → 2.5.0-preview.182
```

## 为什么 provider 凭据继续保留（与 shell 相反）

daemon 派生的子进程走 `minimalEnv()`（只给 PATH / HOME / LANG），
所以清不清 daemon 自身 environ 里的 `*_API_KEY` **不改变子进程**；
而 `anet node start` 路径的 daemon 可能自己要用 provider 凭据。
⇒ 两处差异是设计，不是遗漏；写进测试数据后，差异集合一旦增长就会红。

## Verification

```text
bun test agent-network/src/daemon-inherited-env.test.ts   → 7 pass / 0 fail（此前 3 红）
bun test agent-network/src/package-version-consistency.test.ts → 2 pass
bun test agent-network/src/opencode-agent-node-pair.test.ts    → 6 pass
```

## 发布顺序（这次必须按这个顺序）

```text
① agent-node 2.5.0-preview.182  先发
② 等 registry 可见后再装本包（本包的 pair 常量指向 .182）
```

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.216
```

## Upgrade

```bash
anet upgrade
```
