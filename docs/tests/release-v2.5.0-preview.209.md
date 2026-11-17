# agent-node 2.5.0-preview.209

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.241** 精确配对。

## Why

**RFC-044 slice 2：Windows 本地 daemon / 原生 SDK stop（#3619）。**
Windows 上停止节点过去要等约 **108 秒**（走的是通用超时路径），现在走原生 SDK stop，
实测 **3.8 秒**。

同时带来：Windows 节点的首回复冒烟覆盖、daemon 侧的 stop 证据记录。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.209 @sleep2agi/agent-network@2.3.0-preview.241
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

⚠️ 与 CLI `2.3.0-preview.241` 精确配对；只升 CLI 或只升节点都会配对不上。
