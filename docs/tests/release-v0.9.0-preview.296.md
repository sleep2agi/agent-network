# commhub-server 0.9.0-preview.296

Since `.295`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.296
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.296
```

## What changed

```text
#3864 聊天密钥卡片（request_secret / reply_secret_request）：Agent 在聊天中请求密钥时
      通过结构化元信息渲染安全输入卡片，与 agent-node 2.5.0-preview.229 / App 0.2.618 / Dashboard 0.6.4-preview.662 配套
#3863/#3861 PostgreSQL 兼容修复（补 rowid 列、节点配置读取不再依赖 SQLite rowid）
#3845 新注册节点立即可见于下一次 get_all_status
#3844 已 ack 消息最多退回未读一次，send_task 计入有效输出
#3824 消息无回复时向用户返回单句可读提示
#3809 control=interrupt 回执诚实化（accepted + confirmation:pending）
#3803/#3801/#3800/#3793 路由标签 limit 档位、inbox/user_inbox 索引、聊天轮询 ETag/304 与 >256KB gzip、停顿日志归因
```

## Verified

```text
#3864 及前序 server 改动均已通过 main 全量 CI（commit 1f5ed9c0）
```
