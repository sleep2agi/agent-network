# agent-node 2.5.0-preview.220

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.254** 精确配对。

## Why

**agy 节点开始上报模型清单与登录状态**（`#5321` 第一步；Hub 侧 `.294` 已能投影）：

```text
· config_snapshot.agy_models        string[]（来源：节点真实调用 `agy models`，读不到就不报）
· config_snapshot.agy_login_state   'logged_in' | 'needs_login' | 'unknown'
· 探测在后台跑（启动一次 + 每 10 分钟），带 TTL 缓存；**心跳只读缓存，绝不等探测**
· 没装 / ENOENT / 超时 / 其它错误 ⇒ unknown（不是 needs_login）；探测异常不影响心跳
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.220 @sleep2agi/agent-network@2.3.0-preview.254
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未覆盖

```text
· App 面板（第三段）未开始：现在只是「数据有了」，UI 还没显示
```
