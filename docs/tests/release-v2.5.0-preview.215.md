# agent-node 2.5.0-preview.215

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.249** 精确配对。

## Why

**新节点默认带浏览器能力**（`#5152` 第一步）：

```text
· 建节点时在 workdir 铺好：
    <work>/.agents/skills/browser-use/SKILL.md   （codex / opencode / grok 都读）
    <work>/.claude/skills/browser-use/SKILL.md   （claude 读；opencode 也读）
    <work>/.anet/bin/browser-use                 （wrapper，0755）
· wrapper 固定平台参数：Linux 内置 --args "--no-sandbox"（否则 Chromium 报 No usable sandbox），
  macOS / Windows 不带；所有平台先 `agent-browser close`（--args 只在启动时生效，残留 daemon 会静默忽略）
· 域白名单：设 BROWSER_USE_ALLOWED_DOMAINS=a.com,b.com 时 open 只放行这些主机（域外 exit 2）；
  未设置则放行但打一行 stderr 提醒 —— 不假装安全，也不默认挡死
  （agent-browser 本身没有白名单参数，实测 `skills get core --full` 确认）
· 铺不上只 warn，不阻断建节点（这是默认能力，不是前置条件）
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.215 @sleep2agi/agent-network@2.3.0-preview.249
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未验（不写「已支持」）

```text
· Windows 版 wrapper **不强制**白名单（没有验证过的 Windows 代码路径；写一个没跑过的
  PowerShell host 解析器比诚实的缺口更危险）—— 等有真机再补
· macOS / Windows 实机未验
```
