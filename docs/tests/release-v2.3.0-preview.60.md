# @sleep2agi/agent-network 2.3.0-preview.60 — release notes

两个用户面 CLI 傻瓜化修复（都是 Vincent 实操当场踩到的）：

- **grok attach 找不到节点不再误导用户去 create**（PR #1419，修 #1402 缺陷②）：
  `anet grok attach <node>` 解析失败时，旧文案 `Create it first` 会让用户建出重复节点 /
  撞 tmux/attach session 冲突。现改为可行动提示：说清按 cwd 解析 + 打印 cwd + 列出当前目录
  可见节点 + 指引 cd 过去；create 降为「确认不存在才用」的最后手段。
- **node create --resume 推断 claude-code-cli，不再静默丢 flag**（PR #1420，修 #1390 ①②）：
  `anet node create X --resume <id>`（不带 --runtime）此前 runtime 静默落成 claude-agent-sdk
  且 --resume 值被丢弃。现在 --resume 推断 claude-code-cli（显式冲突则报错退出）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.60 @sleep2agi/agent-node@2.5.0-preview.47
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.60
```

## 本版包含

- `9e5010d0` grok attach 找不到节点给可行动提示（#1419，#1402 缺陷②）
- `925ef793` node create --resume 推断 claude-code-cli（#1420，#1390 缺陷①②）

## Verification

- #1419：临时空目录见证新报错文案；`bun build` rc=0
- #1420：纯函数 `resolveRuntimeForResume` 单测 6 pass + witnessed-red；已接线进 cli.ts；本地隔离环境见证推断消息
