# @sleep2agi/agent-network 2.3.0-preview.68 — release notes

一条 CLI 侧改动，直接对着「grok 共存开箱即用」：**detach 之后不再留下一屏死掉的 TUI**。

- **`anet grok attach` 的会话跑在备用屏幕（alt-screen）**（PR #1514，#1412 残留半）。
  症状：attach 成功、用 `Ctrl-]` 断开后，终端**定格在断开前的 grok 画面**，
  用户以为还连着、在里面打字没反应（输入没到 runtime、节点日志无新记录）。
  修法：整个 attach 会话进备用屏缓冲，detach 时离开 —— 终端把 attach 之前的画面
  **原样还回来**（连用户自己的 scrollback 一起，vim / less / tmux 的标准做法），
  比粗暴 clear 干净。回到主屏后再打一行「已断开 + 怎么重连」，
  否则用户只看到画面变了、不知道是断开还是崩了。
  🔴 附带一条断言**钉住客户端不自己做重绘抖动**：那一半在服务端（#1414），
  两套重绘叠在一起不仅冗余，还会**掩盖服务端那条坏掉** —— 黑屏回归了测试还是绿的。

配合 `agent-node 2.5.0-preview.53` 的 #1518，grok 共存这一轮的四个坑
（attach 黑屏 #1414 / detach 残留 #1514 / 换模型崩溃 #1416+#1509 / 失败不可见 #1518）
到此全部清掉。

🔴 **只有 #1514 进了这个 tarball**。同期合入的 #1515（rest.md 的
`can_create_nodes` 文档）、#1517（Codex TUI 安全重启 runbook）分别在 `docs-site/`，
而 `agent-network` 的 `files` 是 `["dist"]` —— **它们不进这个包**，
在这里列出来只是免得被读成产品改动。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.68 @sleep2agi/agent-node@2.5.0-preview.53
anet hub start
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.68
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

🔴 别只看进程起来了 —— `/health` 返回才证明它在响应。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1514 | #1412 残留半 | attach 会话跑备用屏，detach 原样还原断开前画面 + 断开提示；断言钉住客户端不自重绘 |

pin 链：`PINNED_SERVER_VERSION` → `0.9.0-preview.43`、
`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.53`。
