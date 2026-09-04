# agent-node 2.5.0-preview.66

`.65` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `dab010e4` | #1817 | **#1422** —— grok 共存节点 stop 时,占位文件(.grok .claude .cursor .mcp.json .envrc)在 TUI 证死后、leader 拆卸之前就回收,不再依赖整条拆卸链在 10 s 宽限内跑完 |

## 这一版带给用户什么

`anet node stop` 之后项目目录不再残留 5 个 0 字节占位文件(此前拆卸链被 SIGKILL 打断时会留下,下一次启动才靠 .64 的回收器清掉);test225 那条偶红的形状随之消失。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.66
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.66
anet daemon restart <daemon>        # 或 anet node stop <name> && anet node start <name>
```

## 证据

- `placeholders-reclaimed-before-leader-teardown.test.ts`(withHumanTui 种 5 个占位文件,leader 拆卸开始时目录必须已空;变异去掉提前回收 → 红);grok-copresence 288 测试全绿;typecheck 棘轮 81/81。
- PR #1817 在 main 上 109 项检查全绿(2026-09-04)。

## promote 时的 must_contain

`"version": "2.5.0-preview.66"`(闸 4 对整个 `package/` 目录 `grep -rq`,命中 package.json;`.65` 产物 0 命中)。
