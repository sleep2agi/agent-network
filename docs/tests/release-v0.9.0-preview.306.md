# commhub-server 0.9.0-preview.306

Since `.305`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.306
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.306
```

## What changed

```text
#3918：网络级外部存储中转。在 Hub 里配置 ModelScope / 阿里云 OSS / AWS S3 后，文件、图片、视频直接上传下载到外部存储，
文件字节不经过 Hub 带宽。配置用 vault 加密保存；新增 /api/storage/config、/api/storage/test、/api/uploads/presign、
/api/uploads/complete、/api/files/:id/direct；未配置时行为不变，旧版 agent-node 继续走 /api/upload 与 /api/files/:id。
#3919（#5719）：存储中转出站请求防 SSRF。DNS 解析后拒绝私网 / 回环 / 链路本地 / 组播等地址（含 IPv6 与 IPv4 映射写法），
DNS 失败按拒绝处理；重定向逐跳重验、跨源剥掉 Authorization / Cookie、最多 5 跳；/api/files/:id 旧代理走同一通道。
只发 server；agent-node / agent-network 不动。
```

## Verified

```text
storage-relay 13/13（含 SSRF 单测与 HTTP E2E）、uploads 39/39、uploads-http 15/15、node-files-transport 15/15、
upload-early-reject-guard 3/3、user-avatar-upload-http 5/5、session-source-directory-http 17/17（均为隔离测试库）。
```
