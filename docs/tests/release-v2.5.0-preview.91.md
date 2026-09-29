# agent-node 2.5.0-preview.91

`.90` 之后 `agent-node/` 两个提交（`files: ["dist", "README.md"]`，改动在 `src/` → 打进 `dist/cli.js`）：

| 提交 | PR | 内容 |
|---|---|---|
| 13d4f1c7 | #2058 | daemon 远程建节点可指定工作目录：daemon 自报 `daemon_capabilities.default_workdir_root`（缺省 = daemon `$HOME`），认 `node_spec.workdir`。拒 `$HOME` 本身、其祖先、系统目录和已住别的节点的目录；缺失则 0700 创建，realpath 后再判一次。不在 daemon cwd 的子节点记在 `.anet/child-workdirs.json`，start/stop/delete 照常可用。不带 workdir 时行为不变 |
| 1ade6d42 | #2073 | 节点运行日志：节点上报 `logs_capable`，应答 hub 的 `logs_tail` 请求。只读本节点自己的 `LOG_DIR`，没有路径参数；内容离开节点前先脱敏（令牌、Bearer、各类 key/secret、JWT，以及本节点令牌和敏感环境变量的原值），grep 在脱敏之后执行 |

不新增运行时依赖。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.91
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.118 @sleep2agi/agent-node@2.5.0-preview.91
```

- 运行日志要 hub `commhub-server@0.9.0-preview.66` 起才有（`sessions.logs_capable` 列和 `tail_node_logs` 工具）。旧 hub 会丢掉未知键，客户端显示服务器版本过旧。
- 指定工作目录要 hub 已含 #2058（`0.9.0-preview.64` 起）。
- 🔴 **两个包要一起升**（`agent-network@2.3.0-preview.118 ↔ agent-node@2.5.0-preview.91`）。

## 证据

- #2073：`agent-node/src/runtime/node-logs.test.ts` 16 tests / 89 expects，埋 19 个哨兵 0 个漏出；`tests/qa-node-logs-e2e` 真 hub + 真 agent-node `pass=9 fail=0`，关掉节点脱敏后哨兵断言变红。
- #2058：`agent-node/src/runtime/child-workdir.test.ts` 32 pass；`tests/qa-create-node-workdir` 50 条接进 qa.yml。

## promote 时的 must_contain

`"version": "2.5.0-preview.91"`
