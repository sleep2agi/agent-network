# commhub-server 0.9.0-preview.309

Since `.308`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.309
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.309
```

## What changed

```text
#3934：AWS S3 / 阿里云 OSS 传输加速。数据面（HEAD 探活、预签名 PUT/GET）走加速域名；写前 SSRF 预检改为校验
  实际虚拟主机（<bucket>.s3-accelerate.amazonaws.com）；私有安全探针回走区域控制面端点，仅私有校验不降级；
  加速下拒绝带「.」的 bucket；Cloudflare R2 走 path-style。
#3935：上传/下载三级降级。上传：加速失败切区域 fallback_upload（仍 0 Hub 流量），上游 5xx 且 ≤12 MiB 才降 mode=hub；
  4xx（SSRF/鉴权/超限）保持硬拒。下载：主直连 → 区域 fallback_url → Hub /api/files/:id?proxy=1 鉴权流式代理（保留 ACL/nosniff/Range）。
#3938：>12 MiB 上传在 presign 5xx/4xx 时直接透出真实错误，不再误灌 Hub 导致 HTTP 413。
#3942：按调用方智能路由。AWS EC2 节点直连区域 S3（省 $0.04–0.08/GB 加速费），国内/非 AWS 走 s3-accelerate，
  双向互为 fallback。
只发 server；agent-node / CLI / App 不动。
```

## Verified

```text
storage-relay / file-network-scope / direct-storage 74/74（739 expects）；uploads 54/54；tsc + bun build OK；
check-test-inventory（基线已刷新）/ report-contract-pairs --assert / check-no-live-tokens / check-no-memory-slugs 全过。
```
