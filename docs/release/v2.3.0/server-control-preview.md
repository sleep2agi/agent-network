# Agent Network 2.3 — Server Control Preview

一个服务器，一个 daemon；在 Dashboard、App 或 CLI 中统一管理该服务器上的 Agent。

## 用户能看到什么

- 自动发现服务器上已有的节点，不伪造 Hub 注册记录。
- 创建、编辑、启动、停止、重启均等待 daemon 最终确认。
- daemon 离线、身份冲突、跨网络请求和不安全路径全部 fail closed。
- 旧 `/api/nodes` 语义和旧 CLI 生命周期命令保持不变。

## 对外版本名

统一宣发名：**Agent Network 2.3 — Server Control**。

四个独立 npm 包仍按各自 semver 发布；用户只安装兼容矩阵中的同一行，不需要自行拼版本。候选组合在 Docker 整行验收和服务器 shadow 落地通过后写入 `docs/release/versioning-and-compatibility.md`。

## 一分钟体验

```bash
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
