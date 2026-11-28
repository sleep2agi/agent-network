# agent-network (CLI) 2.3.0-preview.275

与 `@sleep2agi/agent-node` **2.5.0-preview.238** 精确配对（node `.238` 已落地，run `46134491341`）。配套 Hub `0.9.0-preview.311`。

## Why

- **补齐每次下载兜底独立超时信号（`#3956`）**：直传主路由、区域 fallback 与 Hub `?proxy=1` 兜底每次尝试独立创建 `AbortController` 与超时定时器，避免直传 30s 超时后污染后续兜底请求（取代不含 `#3956` 的已取消 `.274` 尝试）。
- **完整包含 Claude Code 频道 S3/OSS 外部存储直传（`#3954`）**：`upload_file` 与频道附件下载优先直连对象存储（0 Hub 带宽），下载通过 `response.body.getReader()` 流式落盘 `0o600` 临时文件，超限当场中止并清理。
- **精确配对 `agent-node@2.5.0-preview.238`**：同步带上 `#3935`（3 级直传兜底）、`#3942`（调用方感知 AWS 同区直传 / CN Transfer Acceleration）、`#3938`（>12 MiB 预签名错误透传）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.275 @sleep2agi/agent-node@2.5.0-preview.238
```

## Upgrade

```bash
anet pair     # 应显示 2.3.0-preview.275 / 2.5.0-preview.238
anet upgrade
```
