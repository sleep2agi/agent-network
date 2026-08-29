# @sleep2agi/agent-node 2.5.0-preview.44 — release notes

这一版只有一件事，但它是 Vincent 当天两次截图抱怨的那件：**grok 共存 TUI 里
斜杠命令被拦时不再沉默**（PR #1404，实现出自 通信SDK牛）。

- 在共享 TUI 提交 `/model`（或任何斜杠命令）被闸门拦下时，attach 终端会立刻看到：
  `[anet] 斜杠命令在共存会话被禁用；换模型请另开终端: anet grok model <node> <model>`
- 「导航后夹带 slash」路由同样给出提示；普通方向键编辑的无斜杠文本照常提交
  （与 main 既有语义一致，#881 以「根本不拒绝」收场）
- 新增 slash-gate / composer-tainted-diagnostics 单测（17 case）与共享 human fixture；
  全量 copresence 集成 66 case 全绿；Docker 回归 25 pass
  （`docs/tests/report-test1244-grok-slash-tui-notice.txt`）

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.59 @sleep2agi/agent-node@2.5.0-preview.44
anet node create
```

🔴 **两个包都要装**（agent-node 单装时飞书桥静默降级，见 .35 说明）。
codex 桥不受影响：`agent-network@2.3.0-preview.59` 的 codex 通道用 npx 钉死解析
`agent-node@2.5.0-preview.43`，与全局安装互不干扰；grok/claude 通道使用全局安装的本版。

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.44
anet node stop <name>
anet node start <name>
```

grok 共存节点重启后（`anet node start <name>`），attach 里输入 `/model` 即可看到提示行。

## 本版包含

- `1ac30f4e` grok 共存：slash 拦截即时提示 + tainted 路由纠偏（#1404，修 /model 静默拦截 DX；关联 #880/#881/#882/#1400/#1402）

## Verification

- 本地 bun：slash-gate + composer-tainted 17 pass；全量 runtime.test.ts 66 pass / 0 fail
- Docker：`anet-test1244-grok-slash-tui-notice` 25 pass / 0 fail（报告见 docs/tests/）
