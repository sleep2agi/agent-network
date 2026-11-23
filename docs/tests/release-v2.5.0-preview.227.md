# agent-node 2.5.0-preview.227

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.261** 精确配对。

## Why

**被 daemon「接管」的节点：远程启动不再被误报失败，用 CLI 启动的节点可以被接管**（`#3842`）：

```text
现象：在 Dashboard 上远程启动一个已接管的节点，节点其实起来了，却显示启动失败；
      用 anet node start 启动的节点，接管时被拒绝
范围：2026-11-10 之后的所有版本
原因：anet node start 从那天起给节点进程加了一个「是哪个 CLI 启动的」的环境变量，
      daemon 校验接管节点时要求每个变量都能复现，这个变量它复现不了
```

修复后该变量在取值是合法版本号时放行。daemon 回报给 Hub 的失败原因保留具体的码（只含变量名，不含值），并写进 daemon 日志。

接管节点的两套 Docker 测试（真实 Hub + 私有 tmux、Codex 两种布局）在修复后全部通过。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.227 @sleep2agi/agent-network@2.3.0-preview.261
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行（应为 2.5.0-preview.227）
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

- 没有在真机上做「接管 + 远程启动」；依据是 CI 的 Docker 测试。
