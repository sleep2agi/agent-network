# commhub-server 0.9.0-preview.310

Since `.309`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.310
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.310
```

## What changed

```text
#3945（P0 安全）：不再把 ModelScope 的原始 token 交给客户端。
  · /api/uploads/presign：若预签名返回的 headers 里含配置的密钥（ModelScope 只有「带 token 的直传」），
    ≤12 MiB 自动降级为 mode=hub（Hub 代收）；>12 MiB 明确 413 并提示改用 S3/OSS 私有桶。
  · /api/files/:id/direct：ModelScope 或任何带鉴权头的下载一律改回 mode=hub 的 Hub 代理 URL（token 不出服务器）。
  · 旧 App / 旧节点无需升级：它们本来就跟随 direct 返回的 mode 回落到 Hub。
#3943：Hub 级托管默认外部存储（宿主机 COMMHUB_STORAGE_* 环境变量）。未配置变量时不生效；配置后无自定义存储的网络自动继承，
  按 anet-files/<network_id>/ 隔离并强制私有；/api/storage/config 增量返回 source / hub_managed_available。
只发 server；agent-node / CLI / App 不动。
```

## Verified

```text
storage-relay 19/19（含「不把 token 交给客户端」与「ModelScope 走 Hub」）；上传相关测试全过；类型检查错误数与 main 持平；
check-test-inventory（基线已刷新）/ report-contract-pairs --assert / check-no-live-tokens / check-no-memory-slugs 全过。
```
