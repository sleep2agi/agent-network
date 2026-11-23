# agent-node 2.5.0-preview.226

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.260** 精确配对。

## Why

**代理只写在节点配置里时，本机请求同样不走代理**（`#3837`）：

```text
只有配置了代理才追加回环豁免（没有代理的机器，节点环境不再多出两个变量）
代理写在节点 config.json 的 env 里（而不是系统环境）时，合并完节点变量后再判断一次
```

本版 agent-node 没有其他行为变化；随 CLI 2.3.0-preview.260 一起发，修的是 Windows 上 Codex 共存节点启动被拒（见 CLI 说明）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.226 @sleep2agi/agent-network@2.3.0-preview.260
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.226）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- 「代理只写在节点配置里」的情形只有单元测试，没有在带代理的真机上复验。
