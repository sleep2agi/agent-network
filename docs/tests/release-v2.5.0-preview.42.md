# agent-node v2.5.0-preview.42 — callCommHub 请求超时

## 变更

- #1384（#1357）：`callCommHub` 的 fetch 加 `AbortSignal.timeout(30_000)`。此前 hub 收下请求但不结束响应时，promise 永不 settle、重试循环停在第一轮、调用方 `.catch` 永不触发——零日志零告警。与 `commhub-mcp.ts` 的 `COMMHUB_CALL_TIMEOUT_MS` 同法同值；TimeoutError 落入既有可重试分支。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.42
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.42
# daemon 托管的机器：升级后重启对应 daemon 使新二进制生效
# 🔴 本机 umask 0002 的机器装完跑一次: chmod go-w "$(npm root -g)/@sleep2agi/agent-node/dist/cli.js" 所在目录链
```
