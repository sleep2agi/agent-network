# @sleep2agi/agent-network 2.3.0-preview.48 — release notes

这一版存在的唯一理由是**把配对指针挪到 `agent-node@2.5.0-preview.35`**。

`2.3.0-preview.47` 内置的 `PAIRED_AGENT_NODE_VERSION` 是 `2.5.0-preview.34`。
`agent-node@2.5.0-preview.35` 发出去之后，没有任何一个已发布的 agent-network
指向它 —— 共存路径按**精确 spec** 解析配对包，所以 `.35` 里的改进
（grok 带外换模型 #879、macOS 进程组身份）**到不了用户手上**。

这一版把指针挪过去。功能改动见 agent-node 2.5.0-preview.35 的 release notes。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.48 @sleep2agi/agent-node@2.5.0-preview.35
anet node create
```

🔴 **两个版本必须成对**。agent-network 会校验解析到的 agent-node 包的
`package.json` 版本**严格等于**它内置的 `PAIRED_AGENT_NODE_VERSION`，
不等就拒绝启动并报 `exact paired package identity validation failed`。
不要只升其中一个。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.48 @sleep2agi/agent-node@2.5.0-preview.35
anet node stop <name>
anet node start <name>
```

已有的 `atok_` token 继续有效，节点配置不需要改。

## 本版包含

- `PAIRED_AGENT_NODE_VERSION` : `2.5.0-preview.34` → `2.5.0-preview.35`
- `PAIRED_AGENT_NETWORK_VERSION` / `package.json` / `package-lock.json`
  同步到 `2.3.0-preview.48`

## Verification

配对断言（`agent-network/src/opencode-agent-node-pair.test.ts`）覆盖：
`PAIRED_AGENT_NODE_VERSION` 与 `agent-node/package.json` 一致、
spec 串由版本拼出、以及**只改 version 一项时校验必须拒绝**
（该分支此前从未被任何用例执行过，2026-08-27 补上）。

版本一致性门（`package-version-consistency.test.ts`）覆盖三个包各自的
`package.json` 与 `package-lock.json`。

## 为什么会出现这个缺口

`agent-node@2.5.0-preview.35` 发到 preview 后，30 分钟窗口内的真实环境烟测
（从 npm registry 装，不是装 CI 产物）抓到了它：

```
已发布的 agent-network@2.3.0-preview.47:
  PAIRED_AGENT_NODE_VERSION = "2.5.0-preview.34"
main 上:
  PAIRED_AGENT_NODE_VERSION = "2.5.0-preview.35"
```

🔴 **两段式发布规则（preview → 烟测 → ACK → latest）在这里第一次真正赚回成本**：
如果当时直接把 `agent-node@latest` 升到 `.35`，共存用户拿到的仍是 `.34`，
而且没有任何东西会报错。
