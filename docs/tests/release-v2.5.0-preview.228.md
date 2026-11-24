# agent-node 2.5.0-preview.228

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.262** 精确配对。

## Why

**Antigravity 节点不再每次回复都先把之前的话重复一遍**（`#3848`）：

```text
现象：在 Antigravity（agy）节点上提问，每次回复前面都带着上一轮甚至更早的一大段内容，
      看起来像「上下文记忆坏了」
范围：agy 每轮都会把之前的回答重新发一次，节点本该把这段去掉；
      当重发的内容以空行开头（例如额度提示）时，去重没认出来，就整段漏给了用户
```

修复后，去重比对时忽略重发内容前后的空白；内容不同的回复不会被误删（有单测覆盖两种情况）。

**Claude 节点启动时在日志里写明用的是哪个 claude 程序**（`#3855`）：

```text
[claude] using bundled binary: <路径>
```

排查「节点用的是不是我装的那个 claude」时直接看日志即可。这一行只在检查通过后打一次，不含凭据。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.228 @sleep2agi/agent-network@2.3.0-preview.262
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.228）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- Antigravity 去重：修复前的同一问题在 Mac mini 真机（小苹果公众号鸽，手工装的修复版）上已确认消失；发布版本身装到真机后再复验一次。
- Claude 日志行：依据 CI 的 Docker 测试（test668）。
