# Agent Network 2.3 — Server Control Preview

一个服务器，一个 daemon；在 Dashboard、App 或 CLI 中统一管理该服务器上的 Agent。

## 用户能看到什么

- 自动发现服务器上已有的节点，不伪造 Hub 注册记录。
- 创建、编辑、启动、停止、重启均等待 daemon 最终确认。
- daemon 离线、身份冲突、跨网络请求和不安全路径全部 fail closed。
- 旧 `/api/nodes` 语义和旧 CLI 生命周期命令保持不变。
- 首个 preview 的远程生命周期与编辑只支持 Linux 主机（安全校验依赖 `/proc`）。

## 对外版本名

统一宣发名：**Agent Network 2.3 — Server Control**。

对外只使用一个名称和入口：**Agent Network 2.3 — Server Control Preview**。
内部兼容行是 CLI `2.3.0-preview.40`、agent-node `2.5.0-preview.31`、Hub `0.9.0-preview.31`、Dashboard/App `0.6.3-preview.55`；用户不需要自行拼版本。

## 一分钟体验

```bash
anet upgrade --channel preview
anet daemon up server-1
anet daemon create server-1 worker-1 --runtime codex-sdk --model gpt-5.5
anet daemon nodes server-1
```

Dashboard / App：**节点 → 服务器节点**。

## 发布门

- 四包兼容组合 Docker E2E 全绿。
- 权限、回执证据和 symlink 三类 mutation 必须 witnessed-red。
- 本服务器仅用 shadow daemon + 专用验收节点落地，不接管既有节点。
- preview 观察通过后才能进入 latest；当前候选不自动 merge、publish 或部署。
