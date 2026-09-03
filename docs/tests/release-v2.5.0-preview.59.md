# agent-node 2.5.0-preview.59

`.58` 之后改到 `agent-node/` 的提交（`files: ["dist","README.md"]`，除测试外都进包）：

| 提交 | PR | 内容 |
|---|---|---|
| `42951f12` | #1774 | **#1615 钉版** —— 启动通过校验的 grok 可执行文件写回 config，下次优先用它（GROK_BINARY 仍最优先）；daemon 自动拉起也钉得住 |
| `af645a91` | #1775 | **#870** —— 网络回合超时后「有上限的等待 + PTY 安静 ≥60 s」才放弃那一轮（显式事件 `network_turn_abandoned`），队列继续 |
| `67fff18c` | #1776 | **#880** —— human_editing 里 10 分钟无按键且有任务在等，替人按 Ctrl-C，队列继续 |

## 这一版带给用户什么

三条都是 grok 共存节点「看起来健康、任务却一条条 300 s 超时」这一族的出口：
- 人在 TUI 里敲了半截走开（09-02 晚 TMWork苹果打包狗 卡 69 分钟那种）→ 10 分钟后自动让路；
- grok 那一轮的 `turn_ended` 没来 → 超时后再等一个超时且 PTY 安静 60 s 才放弃；
- grok 自我更新到验证清单外的版本 → 下次重启仍用上次钉住的那个文件。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.59
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.59
# 三条都在长驻进程内,必须重启节点:
anet daemon restart <daemon>        # 需要 anet ≥ 2.3.0-preview.74
# 早于 .74 的 anet 用两步:
anet node stop <name> && anet node start <name>
```

重启一次之后 config 里会多出 `grokBinary` / `grokBinaryVersion`（#1615 的钉），此后 PATH 上的 grok 再变也不影响下次启动。

## 证据

- `grok-binary-pin.test.ts` 7 条、`stalled-network-turn.test.ts` 5 条、`abandoned-human-editing.test.ts` 4 条、`state.test.ts` +1；test725 自动收；typecheck 棘轮基线不变；test631 私有 config 写点 5 → 6 已登记。

## promote 时的 must_contain

`network_turn_abandoned`（无正则元字符；`.58` 产物用闸 4 原样命令 0 命中，`.59` 的 state.ts/runtime.ts 都含）。
