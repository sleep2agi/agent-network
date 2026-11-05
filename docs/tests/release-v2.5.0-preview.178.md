# @sleep2agi/agent-node 2.5.0-preview.178

发布 `#3418` 后半：会话模型漂出配置后**武装一次对账**，下一次启动自愈。
（`.176` 那次没发出去 —— 主干包清单一度带冲突标记，build 直接挂；本版是同一份代码重发。）

## Why

判据读错了对象（生产实测，通信欧 `n_28e6b2c2`）：

```text
config.json  model = xai/grok-4.7
             opencodeConfiguredModelAtLastOpen = xai/grok-4.7   ← 相等
sessions     model = deepseek/deepseek-flash                    ← 实际在跑的
⇒ shouldReconcile = false ⇒ "keeping the resumed session's selected model"
⇒ 配置说 xai、会话跑 deepseek，判据认为一致，永远不自愈，也没有声音
```

根因：marker 记的是「上次打开时的**配置**」，判据却当成「上次打开时的**会话**」。

## What changed

- `profile-state.ts` 新增 `armModelReconcile(configPath)`：清空 marker。
  空串不等于任何真实模型名 ⇒ 下次启动必判差异 ⇒ 强制对账一次。
  已为空 ⇒ 返回 `false`（心跳不该整天改 config.json）；旧节点没有 marker ⇒ 不凭空造。
- `cli.ts` 的 `pollOpencodeSessionModel`：观察到 `next !== MODEL` 且 marker 非空时清空并 warn。

## Verification

```text
profile-state.test.ts  10 pass
  · 清空 marker ⇒ 下次启动必判差异 · 已为空 ⇒ 幂等返回 false
  · 镜像否定：旧节点没有 marker ⇒ 不凭空造
  · 接线：armModelReconcile 必须挂在 `next !== MODEL` 的条件里（守卫位置判据）
witness：把 armModelReconcile 改成空操作 ⇒ 2 例红（同一 marker 两种断言，连坐）
```

## 行为变化（唯一一条，写在这里而不是埋在 diff 里）

TUI 里手动切的模型，重启后会回到配置值。旧语义是「保留 TUI 选择」。

## What it does not do

- 不决定「配置 vs 会话」谁更高，只在发现不一致时让下一次启动按配置执行。
- 生效需要一次节点重启（启动时才读 marker）。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.178
```

## Upgrade

```bash
anet node restart <name>
```
