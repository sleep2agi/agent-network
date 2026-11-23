# @sleep2agi/agent-network (CLI) 2.3.0-preview.260

与 `@sleep2agi/agent-node` **2.5.0-preview.226** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

**原生 Windows 上 Codex 共存节点恢复可以启动**（`#3840`）：

```text
现象：新建节点时能选「Codex 共存 TUI」并建成，anet node start 却报
      "Native Windows supports claude-agent-sdk by default; … co-presence runtimes are unavailable"
范围：2026-11-17（#3619）之后的所有版本
原因：那次为 Windows 加的启动入口检查，把 8 月起就有的原生 Windows Codex 共存一并拦了
```

修复后，Windows 上的整套 Codex 共存测试（新建、首次启动、续接、回合中收消息、停止）全部通过。

**仍被拒绝的启动方式会说清原因和下一步**：`--tmux`、`--accept-dev-channels`、Grok 共存、尚未支持的运行时，各有一句说明（原来共用一句）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.260 @sleep2agi/agent-node@2.5.0-preview.226
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.226
anet upgrade
```

## 未验

- 没有在装了真实 Codex 登录的 Windows 机器上手动启动过；依据是 CI 的 Windows 原生测试（用替身 Codex）。
