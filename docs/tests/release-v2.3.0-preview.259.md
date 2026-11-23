# @sleep2agi/agent-network (CLI) 2.3.0-preview.259

与 `@sleep2agi/agent-node` **2.5.0-preview.225** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

**原生 Windows 上 `anet node create / start / stop` 可用于 OpenCode V2 节点**（`#3826` `#3835`）：

```text
create：节点配置的检查在 Windows 上不再要求 uid 和权限位
start --copresence：不需要 tmux，命令本身就是节点进程，前台运行
stop：结束节点，不影响共享 Server
生命周期锁在 Windows 上改用目录改名（exFAT 数据盘不支持目录链接）
```

在一台 Windows 11 真机上按上面三条命令依次走通。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.259 @sleep2agi/agent-node@2.5.0-preview.225
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.225
anet upgrade
```

## 未验

- Windows 上命令结束时偶发断言导致退出码非 0（命令本身已成功）。
- 节点工作目录不能位于 agent-node 安装目录之下。
