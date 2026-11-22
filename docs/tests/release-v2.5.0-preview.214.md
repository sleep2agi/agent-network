# agent-node 2.5.0-preview.214

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.248** 精确配对。

## Why

两笔 agy（Antigravity）真机修复，均由负责人真机复验（重启节点后两轮对话干净）：

```text
#3739  agy 版本按「建议」处理，不再当闸门
        · newer / older 只打一行告警，不 throw —— 版本不 match 不再把整个节点带废（真机上发生过）
        · 仍然硬失败只剩两种真坏：读不到版本、没有 acp 子命令
        · AGY_STRICT_VERSION=1 时恢复严格锁版本（需要精确钉版本的场景用）
#3740  agy 会话只在进程内保留，回放的回复去掉前缀
        · 重启节点后再跑两轮：「记住了」→「靛蓝海豚-825193」，不再出现前缀堆叠
```

## ⚠️ 预期的行为变化（运维请先读这条）

```text
· 重启节点后 agy **不再续会话**：上下文只在**同一进程运行期间**保持；
  重启即新会话，上一次聊过的内容不会被带回来。
· 这不是回归，而是 #3740 修掉「把旧回合回放进来、还堆前缀」的直接结果。
  看到「重启后不记得上文」时按预期行为处理，不要当 bug 报。
· 需要跨重启保留对话的，等后续版本（本版没有该能力，也不假装有）。
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.214 @sleep2agi/agent-network@2.3.0-preview.248
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 验证口径

```text
· 负责人真机（ANet 反重力节点）：重启后两轮对话回复干净；agy 1.5.14 版本告警正常打印且不阻断
· 自动更新关闭后的版本不匹配场景：仅告警（AGY_STRICT_VERSION=1 才硬失败）
```
