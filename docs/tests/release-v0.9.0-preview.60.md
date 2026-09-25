# `@sleep2agi/commhub-server@0.9.0-preview.60`

## 为什么发这一版:节点请求内容不再长期留在 hub(#2001)

| 提交 | PR | 内容 |
|---|---|---|
| 8b543a6a | #2001 | `node_rules_requests` 里暂存的文件内容(规则文件、SKILL.md、项目文件夹读取结果、写入载荷)按保留策略清理:请求方首次取到终态结果后 60 s 清空内容;未被取走的 24 h 后清空;30 天后删行。只清文件字节,状态/文件名/时间/请求方保留作审计;超过 24 h 仍 pending 的请求先判 timeout,避免节点隔天拉到已被清空的写入 |

60 s 而不是立即清:同一请求可能被两个窗口同时等待(并发被拒后跟随既有 request id),立即清会让第二个拿到空内容,规则编辑器载入空文本,保存即清空节点文件。

⚠️ 首次部署后的第一轮清理会清掉所有超过 24 h 的旧内容(生产副本实测:清 34 行、判 1 行 timeout、删 0 行)。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.60
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.60
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

节点侧无需改动(agent-node .88 / agent-network .115 不变)。

## 证据

- 新增 6 条测试 58 个断言;12 种变异全部变红;hub 全量 112 文件 1325 pass / 0 fail;10 道 doc/仓库门 rc=0。

## promote 时的 must_contain

`"version": "0.9.0-preview.60"`
