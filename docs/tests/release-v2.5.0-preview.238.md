# agent-node 2.5.0-preview.238

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.273** 配对；CLI `2.3.0-preview.274` 起精确配对到本版本。配套 Hub `0.9.0-preview.311`+。

## Why

- **Claude Code 通道支持 S3/OSS 直传（`#3954`）**：`claude-code` 节点的回复附件与受控本地文件走外部存储直传（0 Hub 带宽）、下载支持三级回落；下载改为**流式写临时文件**（不整文件进内存，超限当场中止并清盘）。
- 同版包含 `#3935`（三级降级）、`#3942`（AWS 同区直连 / 国内走加速）、`#3938`（>12 MiB 透出真实 presign 错误）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.238 @sleep2agi/agent-network@2.3.0-preview.273
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.238
anet upgrade
```
