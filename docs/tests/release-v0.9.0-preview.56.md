# `@sleep2agi/commhub-server@0.9.0-preview.56`

## 为什么发这一版:**规则文件读写可以按别名找到没有节点行的会话**(#1977)

`.55` 之后 `server/src` 一个功能提交:

| 提交 | PR | 内容 |
|---|---|---|
| 102ad172 | #1977 | Claude Code 会话节点也能远程读写规则文件(CLAUDE.md);节点上报 `rules_file_capable`,hub 可按别名定位会话 |

- `sessions` 新增粘性列 `rules_file_capable`,只在调用者的节点 token 与该 alias 绑定时写入(单独一条 UPDATE,不动 test698 钉死的 upsert INSERT);`/api/status` 以布尔暴露。
- `read_node_rules_file` / `write_node_rules_file` 新增 `alias` 参数:有节点行就用节点行,否则找声明了能力的会话(队列里记作 `session:<alias>`);pull / ack 都校验网络;找不到能服务的目标立即 `rules_file_target_not_found`,不再空等 60 秒。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.56
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.56
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

节点侧能力要配套 `agent-network@2.3.0-preview.111` + `agent-node@2.5.0-preview.84`;旧节点不上报能力时行为与 `.55` 相同。

## 证据

- hub `rules-file-session-target` 9 pass(新)、`rules-file-transport` 10 pass;hub 全量 1286 pass / 0 fail;origin/main 上新测试 0/9;去掉 pull / ack 的网络过滤各自让隔离测试红。
- 一次性 hub 端到端:能力 true;按别名读出 CLAUDE.md;写入落盘再读回;AGENTS.md 未被碰;未知别名立即拒绝。

## promote 时的 must_contain

`"version": "0.9.0-preview.56"`
