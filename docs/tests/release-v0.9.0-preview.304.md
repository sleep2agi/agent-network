# commhub-server 0.9.0-preview.304

Since `.303`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.304
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.304
```

## What changed

```text
#3905（#5653）：网络统一语音输入（豆包 ASR）。网络 owner / admin 在 Hub 上配置一次火山引擎凭据
（vault AES-256-GCM 加密存储，独立表 network_voice_configs），App 登录后向 Hub 取 Key 直连豆包，成员不用自己配。
- GET /api/voice/config：成员读状态，不含明文；PUT / DELETE 仅 owner / admin。
- GET /api/voice/credentials：仅发给本网络的人类成员（节点令牌 / 非成员 / viewer 403，停用 409），
  Cache-Control: no-store；每次发放记审计 voice_credentials.issue（不记 Key）。
- 没有配置 ANET_HUB_SECRET_VAULT_KEY 的 Hub 照常启动，写配置时返回 503 并说明。
只发 server；agent-node / agent-network 不动（仍为 2.5.0-preview.234 / 2.3.0-preview.270）。
相对线上 .297，本版同时带上 .298–.303 的全部修复（停顿主因索引、管理员部门范围、后台计时等）。
```

## Verified

```text
#3905：voice-asr + vault 24/24、voice-asr-http（含 viewer 403、审计、删除网络清理）通过；CI 79 项 0 红。
```
