# agent-node 2.5.0-preview.224

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.258** 精确配对。

## Why

**「停止」在任务进行中真的生效**（`#3810`）：

```text
以前：只有 OpenCode 会在收到停止时立刻处理；Claude / Codex / Antigravity / Grok 要等当前任务跑完才轮到它，等于没停
现在：所有运行时一收到停止就处理，不排在正在跑的任务后面
同一条停止只处理一次，不会停两次、回两条
任务已经结束后再点停止，如实告知「当前没有在跑的任务」
没有停止通道的运行方式（Grok 的 CLI 模式、旧版 Codex）如实告知不支持，不再显示可用
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.224 @sleep2agi/agent-network@2.3.0-preview.258
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.224）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- 真机停止：本版发布后在 Antigravity 节点上复验（长任务中途停止，节点日志里处理停止的时间早于任务结束）。发布时尚未做。
- Claude / Codex / Grok 的真机停止尚未做；它们与 Antigravity 走同一条即时处理通道，但各自的停止动作只有单元测试。
- Antigravity 回放剥离（`.223`）在真机上仍未复现回放场景。
