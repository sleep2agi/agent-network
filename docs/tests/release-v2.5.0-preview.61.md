# agent-node 2.5.0-preview.61

`.60` 之后只有一个提交,但没有它 `.60` 里的 #1770 那一半**根本不生效**:

| 提交 | PR | 内容 |
|---|---|---|
| `483501e2` | #1781 | **#1770 补漏** —— `grok-build-cli-home.ts` 稳定化 commhubMcp 时是显式五字段重建,`.60` 新加的 `activeTaskFile` 在那里被丢掉,真机 `config.toml` 的 mcp env 里没有 `ANET_ACTIVE_NETWORK_TASK_FILE`,node-server 拿不到标记路径,改写从未武装(DEV grok-v1 实测:探针出站仍 2 条) |

## 这一版带给用户什么

装了 `.60` + anet `.77` 的共存节点,发起方仍会收到模型自己发的那条重复 send_task;`.61` 之后 node-server 才真的拿到标记路径。**要重启共存节点**(config.toml 是启动时生成的)。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.61
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.61
npm i -g @sleep2agi/agent-network@2.3.0-preview.77   # node-server 那一半
anet node stop <name> && anet node start <name> --copresence   # config.toml 启动时重生成
```

## 证据

- `grok-build-cli-home.test.ts` 新断言(传 `activeTaskFile` 后 config.toml 含 `ANET_ACTIVE_NETWORK_TASK_FILE = "<路径>"`):修前 1 fail,修后 43/43。
- typecheck 棘轮 81/81 不变。
- 发布后在 DEV grok-v1 重做探针,目标出站 = 1(只剩运行时 reply),结果回填到 #1770。
