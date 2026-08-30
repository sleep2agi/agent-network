# @sleep2agi/agent-node 2.5.0-preview.53 — release notes

三条 grok / BTW 共存的可靠性与**可诊断性**修复。前两条直接对着「共存节点开箱即用」
这个目标：失败要么不再发生，要么**说得出为什么**。

- **recovery TUI 退出时透出 grok 的真实输出**（PR #1518，#1400）。
  症状：把既有 grok 会话 pin 进共存节点后启动，节点循环打
  `resume attempt N/3 failed: Grok recovery TUI exited before recovery drain`，
  **日志里没有任何一行说明 TUI 为什么退**，三次重试三次同句、任务全部失败。
  根因**不是没抓到 grok 的 stderr，而是抓到又扔掉**：PTY 把 stdout/stderr 合成一路，
  `tuiReadinessBuffer` 在 composer 就绪之前一直累积着这些字节（那句
  `error: cannot resume this session under sandbox profile ...` 就在里面），
  而 `pty.onExit` 的第一件事就是清空这个缓冲。
  修法：onExit **先抓再清**，错误里挂上 `; grok said: <最后几行>`；
  🔴 抓不到任何可见输出时改打 `(grok printed nothing before exiting)` ——
  **空白不该被读成「没异常」**。取尾按**行**不按字节（grok 崩前可能刚画过一整屏 ANSI，
  按字节取会拿到那一行的中段乱码、真错反而被挤掉）。
  只用**就绪前**的缓冲：它在就绪那一刻即被清空，所以装的只有启动期输出，
  **不含人类后来打进 TUI 的内容**。

- **换模型的观察窗口改成「观察到轮转就关」**（PR #1509，#1413 残留）。
  #1416 的正确性原本押在「轮转发生在 ack 之后 3000ms 内」这条**从未实测过**的假设上：
  大会话 / 忙碌 session / grok 慢的时候轮转迟到，窗口已被定时器关掉，
  boundary error 走回 `failFatal` —— #1413 的原始现象照旧复现。现在窗口的**关闭条件**
  是「观察到轮转」，硬上限同时放宽。

- **BTW 侧线程：reconcile 出 turnId 后也绑定已存在的 live execution**（PR #1512，#1449 f3）。
  reconcile 拿到 turnId 时若该 execution 已经在跑，此前不会绑定，
  早期 terminal 事件与 pendingTerminal 会滞留；现在一并 flush。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.68 @sleep2agi/agent-node@2.5.0-preview.53
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.53
# 共存节点需要重启才会用上新 runtime
anet node restart <节点名>
```

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1518 | #1400 | recovery TUI 退出时透出 grok 真实输出（先抓再清 / 按行取尾 / 空输出明确说明） |
| #1509 | #1413 残留 | 换模型窗口改为「观察到轮转即关」，去掉「轮转必在 3000ms 内」这条未实测假设 |
| #1512 | #1449 f3 | reconcile 出 turnId 后绑定已存在的 live execution，flush 早期 terminal |
