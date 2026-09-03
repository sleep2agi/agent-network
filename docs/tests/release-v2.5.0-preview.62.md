# agent-node 2.5.0-preview.62

`.61` 之后 `agent-node/` 两个提交,都是共存节点在真机上踩出来的:

| 提交 | PR | 内容 |
|---|---|---|
| `e385aabc` | #1783 | **#1770 第三层** —— 标记路径真正传给运行时(写方),并从项目 `.anet/`(对沙箱内 node-server 是 deny 的)搬到 `<home>/.anet-grok-credentials/<key>/`(node-server 已在那里读 `.env`);同一个变量同时交给读写双方 |
| `365ae45c` | #1784 | **#1767** —— 被 SIGTERM / `anet node stop` 打断在 post-stop 清理之前留下的五个 0 字节 0444 占位,下一次启动不再被拒:prepare 放行精确占位形状,runtime 拿到项目锁后回收 |

## 这一版带给用户什么

- 共存节点 `anet node stop` 之后再 `start` 不用再手删 `.grok .claude .cursor .mcp.json .envrc`(TMWork苹果打包狗、grok-v1 各踩过)。
- 配合 anet `2.3.0-preview.77`,模型对任务发起方的重复 send_task / send_message 应被改写成不推送的进度上报;`.60`/`.61` 都因为路径没接到位而没生效,这是第一版真正把读写两端接在同一个可读位置的。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.62
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.62
npm i -g @sleep2agi/agent-network@2.3.0-preview.77
anet node stop <name> && anet node start <name> --copresence   # config.toml 启动时重生成;这一次 stop 后不用手删占位
```

## 证据

- `active-network-task-marker.test.ts` +2(凭据目录拼法;cli.ts 两处用同一变量)、`grok-build-cli-home.test.ts` +1(五占位 prepare 不抛、回收恰好五个、真文件仍拒);typecheck 棘轮 81/81。
- 发布后在 DEV grok-v1 做第四次探针,目标出站 = 1,结果回填 #1770。

## promote 时的 must_contain

`stale project placeholder`(`.61` 产物 0 命中,已用闸 4 原样命令验)。
