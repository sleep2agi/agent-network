# agent-node 2.5.0-preview.223

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.257** 精确配对。

## Why

**Antigravity 回放不再冒充本轮结果**（`#3802` / 卡 `#5369`）：

```text
本轮只有回放、没有新内容 ⇒ 判失败（agy_replay_only_no_new_content），绝不把上一次的回复当结果发出去
给用户看的是人话：「这次没有生成新内容，请重发一次；如果反复出现，换一个新会话」
回放剥离改为「按记录顺序拼前缀、取最长命中、每条只剥一次」⇒ 不误伤正常重复回答
续会话时用 session/load 回放给历史做种子（替换式，不随轮数增长）⇒ 进程重启后仍能识别回放
换新会话重做成功时，回复前带「（上个会话没有生成新内容，已换新会话重做，之前聊过的内容它可能不记得）」
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.223 @sleep2agi/agent-network@2.3.0-preview.257
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.223）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- Antigravity 真机：握手回放文本与回合内前缀是否逐字节一致（不一致会导致剥离失效、退回旧行为）—— 需真机验证。
- agy 停止能力（`turn_interrupt_capable`）首次真机验证尚未做。
