# agent-network (CLI) 2.3.0-preview.241

与 `@sleep2agi/agent-node` **2.5.0-preview.209** 精确配对。

## Why

**RFC-044 slice 2：Windows 本地 SDK 节点的启动、首条回复、原生停止（#3619）。**
这一版的主要改动在 **CLI 侧**：

- `bin/cli.ts` 去掉 `win32` 闸，加入 Windows SDK 二进制解析；
- `anet node stop` 在 Windows 上走**原生停止**：常驻 PowerShell helper + Toolhelp 证据 + `taskkill` ACK；
- 用 `$PSHOME\Modules` 修复了 `PSModulePath` 缺失导致的卡死。

效果：Windows 上停止节点从 **约 108 秒 → 3.8 秒**（daemon 的 stop 也是经 CLI 完成的）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.241 @sleep2agi/agent-node@2.5.0-preview.209
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

⚠️ 与 agent-node `2.5.0-preview.209` 精确配对；Windows 上的快速停止需要 CLI 与节点同时升到这一对。
