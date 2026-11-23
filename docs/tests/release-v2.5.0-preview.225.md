# agent-node 2.5.0-preview.225

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.259** 精确配对。

## Why

**原生 Windows 上运行 OpenCode V2 节点**（`#3812`：`#3813` `#3818` `#3826`）：

```text
节点连接本机已在运行的共享 OpenCode Server，自己不启动 OpenCode 进程
注册、收发、跨轮记得上文、停止、被强行结束后回到原会话 —— 在 Windows 11 和 Windows 10（非管理员）两台真机上验证
共享 Server 的密码文件按「只有你自己能读」判断（访问列表），不再一律拒绝
本机回环请求不走代理；带 BOM 的配置能读；盘符大小写、斜杠方向不同的路径视为同一目录
```

**Antigravity**（`#3825`）：未登录的机器在新建节点时显示「未登录」；报错改为一句人话并给出下一步，标签不再误写成 grok。

**共享 OpenCode Server 不再被误停**（`#3814`）：一个节点创建失败时，不会把其他节点在用的共享 Server 当成残留清掉。

**进程被杀后能再启动**（`#3826`）：工作目录原本没有 OpenCode 配置时，上一次留下的配置不再让下一次启动拒绝（Linux 上同样受益）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.225 @sleep2agi/agent-network@2.3.0-preview.259
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.225）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- Windows：中文工作目录只有本机测试；共享 Server 的启停与开机自启没有命令，需自行保持运行（真机上见过一次 OpenCode 自带运行时崩溃退出）。
- Windows：`anet` 命令结束时偶发断言导致退出码非 0；`anet node delete` 在共享 Server 仍加载节点目录内插件时报目录非空。
- Windows 节点在 Dashboard 里暂无模型列表。
- Antigravity 的修复未在出问题的那台机器上复验。
