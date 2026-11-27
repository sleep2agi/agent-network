# commhub-server 0.9.0-preview.308

Since `.307`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.308
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.308
```

## What changed

```text
#3931：外部存储只允许私有仓库 / 私有 Bucket（admin 要求：严禁 public 中转站 / public OSS）。
  · 任何非空 public_base_url 直接拒绝（400 invalid_public_base_url）；旧配置读取时置空；下载只走鉴权头或短期预签名 URL，不再有匿名直链分支。
  · ModelScope 强制 Data.Visibility===1；公开（5）或未知一律 400 public_storage_forbidden。
  · OSS / S3 四层校验：匿名 list、匿名 HEAD、签名 ?acl、签名 ?policyStatus / ?policy（501 降级），任一命中即拒绝；探针全走 safeStorageFetch，保留 SSRF 防护。
  · enabled=false 停用时放行，便于立刻关闭。
  · 同时合入提交合并队列（80ms 微批、429 / commit lock 退避）与 ModelScope objects=[] 去重。
只发 server；agent-node / CLI / App 不动。
```

## Verified

```text
storage-relay 15/15（467 expects，含仅私有策略 E2E：公开 base_url、公开 ModelScope、公开 OSS/S3 ACL/Policy、私有 bucket ?acl=403 判私有）；
uploads 54/54、vault 18/18；tsc 改动文件 0 errors；bun build OK；
report-contract-pairs --assert / check-no-live-tokens / check-no-memory-slugs / check-test-inventory 全部 PASS。
```
