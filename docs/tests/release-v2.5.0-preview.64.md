# agent-node 2.5.0-preview.64

`.63` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `661518c2` | #1805 | **#1104** —— explicit-delegation 最后那条「让/请/麻烦 X …」模式加 `^` 锚点(`m` 标志,行首也算):只有整句/整行以它开头才算派单 |

## 这一版带给用户什么

claude-agent-sdk 节点在散文中间提到「…它能让 TM网站运维 免于…」「…请 TM负责人 确认…」时,不再被切片成一条 send_task 转发给第三方。TM 运维线 9 例幽灵任务(5 节点 4 机器)全部来自这一条模式;两条真实误判原文进了回归测试(必须 null),两条阳性照旧命中。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.64
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.64
anet daemon restart <daemon>        # 或 anet node stop <name> && anet node start <name>
```

## 证据

- `cli-explicit-delegation.test.ts` +4(两条 TM 真实误判原文 → null,两条行首阳性);变异去掉 `^` 锚点 → 两条阴性红。
- PR #1805 在 main 上 109 项检查全绿(2026-09-04,重跑基线为 #1806 关掉 npm audit 之后)。

## promote 时的 must_contain

`/^(?:让|请|麻烦)`(`.63` 产物 0 命中、`.64` 产物命中;`^` 不在 BRE 模式开头故为字面量,已用闸 4 原样 `grep -rq` 两向验)。
