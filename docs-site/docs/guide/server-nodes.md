# 服务器节点管理

每台运行 Agent 的服务器启动一个 daemon。它只管理自己目录下的节点；CLI、Dashboard 和 App 共用同一套权限与状态。

> 本功能当前仅在 `preview` 兼容组合中提供。Hub、agent-node、CLI 和 Dashboard 必须按[版本矩阵](/guide/versioning)整组升级。
> 首个 preview 仅支持 Linux 主机；进程身份和防路径竞态依赖 `/proc`。Windows/macOS 暂不开放远程启停与编辑。

```bash
anet upgrade --channel preview
```

## 1. 启动服务器 daemon

在该服务器的项目目录执行：

```bash
anet daemon up server-1
```

一个项目目录只运行一个 daemon。不要共用目录，也不要用 `pkill`/`killall` 停进程。

## 2. 管理节点

```bash
anet daemon nodes server-1
anet daemon create server-1 worker-1 --runtime codex-sdk --model gpt-5.5
anet daemon node stop server-1 worker-1
anet daemon node edit server-1 worker-1 --model gpt-5.6
anet daemon node start server-1 worker-1
anet daemon node restart server-1 worker-1
```

命令会等待服务器最终确认，不把“已下发”冒充“已完成”。编辑仅允许在节点停止时执行。

## 3. Dashboard / App

打开 **节点 → 服务器节点**：选择服务器后即可新建、编辑、启动、停止和重启。App 使用同一个页面与 API。

## 安全边界

- daemon 只上报脱敏 inventory，不上传 token、env、prompt 或主机绝对路径。
- network、alias、node_id 必须同时匹配；冲突节点会隔离，不能自动启停或改写。
- symlink、路径穿越和不可信启动器会被拒绝。
- daemon 离线时不接受操作；恢复后 inventory 会重新收敛。
- 当前只远程创建已验证的无头 runtime：`claude-agent-sdk`、`codex-sdk`、`grok-build-acp`。TUI 节点可被发现和启停，但暂不远程创建。

## 排查

```bash
anet daemon list
anet daemon nodes server-1
anet node status server-1
```

先确认 daemon 在线，再查看节点是否显示 `quarantined`。隔离状态必须人工核对身份，不能强制覆盖。
