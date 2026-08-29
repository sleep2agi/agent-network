# @sleep2agi/agent-node 2.5.0-preview.48 — release notes

这一版修掉 **grok 共存节点换模型时崩溃**（PR #1416，修 #1413）——Vincent 亲历、且此前
「grok-tui 做得差」抱怨的那件事之一。

- grok 换模型时会 rotate/truncate 它的 `chat_history.jsonl`；tail 跟随器看到文件缩小到
  offset 之下会判为篡改、节点 fatal 自毁。本版在换模型窗口内 **re-arm（重锚）JSONL tail**，
  把这一次轮转当作预期、recover 而非自毁。
- 独立复核发现的**热路径窗口关太早**风险（grok 若先 ack、几毫秒后才轮转，仍会崩）也已修：
  换模型窗口加 3s 宽限，迟到的轮转仍 recover-by-rearm；防篡改不变式（窗口外截断仍 fatal）保留。
- 新增两个见证测试：#1413 同步截断 recover、#1416 review「ack 后轮转」走 poll-fallback recover。

🔴 **真机说明**：单测用真实 SafeJsonlTail 读真截断文件（非 mock），且 #1413 崩溃证据表明 grok
是 truncate（不是 rename）——修复正好覆盖。真机 grok 1.0.5 端到端复验仍建议补，但本版对
当前会崩的状态是净改善、且不削弱防篡改。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.60 @sleep2agi/agent-node@2.5.0-preview.48
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.48
anet node stop <grok节点>
anet node start <grok节点>
# 之后 attach 里换模型不再崩
```

## 本版包含

- `5a2578df` grok 共存换模型 re-arm JSONL tail + 热路径宽限（#1416，修 #1413）

## Verification

- 独立复核 A–D PASS + HIGH 项（热路径窗口）已修+测；全量 grok-copresence runtime.test.ts 68 pass
- witnessed-red 已见（还原同步清窗口 → 「ack 后轮转」测试节点自毁）
