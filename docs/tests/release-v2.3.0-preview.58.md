# agent-network v2.3.0-preview.58 — claude-code-cli 节点日志

## 变更

- #1386（#1345）：`node-server.js`（claude-code-cli stdio proxy）把每条日志双写进 `.anet/nodes/<alias>/logs/<UTC日期>.log`——该模式没有 agent-node 进程，此前 logs/ 恒空，「按 alias 读节点日志」对半个舰队结构性做不到。含 stop 竞态防护：节点目录被 stop 拆除后 sink 永久停写、绝不重建目录。
- PAIRED_* 版本字面量随 sync-pinned-versions.sh 同步。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.58
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.58
anet --version   # 应显示 2.3.0-preview.58
# 已有 claude-code-cli 节点：下次 anet node start 时 .anet/node-server.js 会刷新为新 bundle
```
