# agent-node v2.5.0-preview.46

从 main 发布，带出 preview.45 之后合入的 attach 体验修复：

- **#1412**（grok 共存）：`anet grok attach` 连上后强制一次重绘，消除**黑屏**。此前 grok 不在新客户端 attach 时重画屏幕，客户端连上发的初始 resize 若等于当前 PTY 尺寸是 no-op，于是 idle 的 TUI 对新 attach 显示黑屏（用户以为"没连上/这不是 TUI"）。现在连上首次 resize 时做一行抖动强制 grok 全量重画。control 连接不受影响，不碰任何安全机制。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.46
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.46
agent-node --version   # 期望 2.5.0-preview.46
```

grok 共存节点升级并重启后，`anet grok attach <node>` 连上即显示 TUI 界面，不再黑屏。

## Verification

- attach.test 14/14（新增 terminal 触发重绘 / control 不触发用例）、runtime.test 66/66 无回归
- 实机验证（连 attach.sock 观察 grok 输出）：连上不动 0B、同尺寸 resize no-op 0B、抖动 14606B 全量重画
- 五格门合并至 main（commit 585e917c）

## 已知未修

- **#1413**：restart/hot 型换模型仍会崩节点（tail 防篡改校验误判 grok 日志轮转），修复方案见 issue，本版未含。换模型请暂缓。
