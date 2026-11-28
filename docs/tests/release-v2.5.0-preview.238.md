# agent-node 2.5.0-preview.238

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.273** 配对；CLI `2.3.0-preview.274` 起精确配对到本版本。配套 Hub `0.9.0-preview.311`。

## Why

- **外部对象存储 3 级上传/下载容错兜底（`#3935`）**：节点侧上传与附件下载支持「主直传路由 → 区域直传 fallback → Hub `?proxy=1` 兜底」，对象存储单路径抖动时自动平滑回落。
- **调用方感知 S3 路由（`#3942`）**：节点自动识别云环境并携带 `X-Anet-Caller-Cloud` 请求头，AWS EC2 节点走同区 S3 直传，中国大陆/桌面端走 AWS S3 Transfer Acceleration，大文件直传不绕 Hub 带宽。
- **大于 12 MiB 上传错误透传（`#3938`）**：预签名失败时直接返回真实错误原因，不再误落入 Hub 本地上传触发 413。
- **Windows 路径保留与 ACP `upload_file` 注册（`#3937` / `#5757`）**：修复 Windows 证据路径处理并为 ACP 运行时补齐 `upload_file` 工具注册。
- **Claude 停止行为回归锁（`#3940` / `#5759`）**：锁住停止后不重试、空闲停止返回 `no_active_turn` 的行为不变式。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.238 @sleep2agi/agent-network@2.3.0-preview.273
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.238
anet upgrade
```
