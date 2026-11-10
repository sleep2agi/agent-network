# 2.3.0-preview.200

> 与 `@sleep2agi/agent-node@2.5.0-preview.165` 配对的 CLI 版本（`#1811` 的 pair 守卫要求两半同时存在）。

## 这一版带来什么

CLI 本身改动很少，主要是把节点运行时钉到 `.165`：

```
agent-node 2.5.0-preview.165 带两条改动：
  ① 轮询纪律进提示词（#3237）：get_task 两次之间至少隔 60 秒，且说明「不盯着不会丢结果」
  ② 超时后的迟到结果补回（#3249 / #3071）：这一轮后来跑完了，结果会补发回 Hub
```

## 配对

```
PAIRED_AGENT_NETWORK_VERSION = 2.3.0-preview.200
PAIRED_AGENT_NODE_VERSION    = 2.5.0-preview.165
```

两个包必须同时在 npm 上预览通道可用，否则 `opencode-agent-node-pair` 的绊线测试会红。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.200
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.200
anet --version    # 应为 2.3.0-preview.200
```
