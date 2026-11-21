# commhub-server 0.9.0-preview.289

Since `.288`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.289
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.289
# production: scripts/deploy-hub-runtime.sh --version 0.9.0-preview.289
#   本机 profile（~/.local/bin/hub-daemon.sh）是硬编码 HUB_RUNTIME_DIR 的部署方式：
#   改那一行指向新 runtime 目录后 `pm2 restart commhub-hub`，失败回指上一版。
```

## What changed

```text
#3694  #4821 OpenCode session 投影层（Hub）
        · 六字段投影 + epoch ms → ISO-8601 UTC + cursor opaque
        · 纯函数；缺字段/上游形状异常/epoch 边界都有测试
        · 这是「客户端新建节点时可选已有 Session」的 Hub 侧前置

#3698  #4821 agent-node 只读列出 OpenCode V2 sessions
        · GET /api/session 分页（limit 夹到 100），形状不对时报错而不是装成「没有」
        · 测试桩已修：stubFetch 用完还原 globalThis.fetch（之前会泄漏到同进程其它用例）

#3685  B 止血：acked 后窗口内无回复判「未投递」
        · 判定层 + 每分钟扫描（10 分钟无回复把 inbox.acked 回退为 0 并发 acked_unconfirmed）
        · 回复成功即 markReply，避免把有回复的消息误判成未投递

#3724  修 main red：测试里硬编码 /home/<user> 路径 → /srv/proj（home-path 基线检查）

fix   provider-selection 快照查询加 rowid 兜底排序
        · 原来 ORDER BY created_at DESC LIMIT 1 —— 同一毫秒写入两条时顺序不确定，
          测试与生产都可能读到旧的那条（CI 上稳定复现成 pending 而不是 applied）
        · 改为 ORDER BY created_at DESC, rowid DESC（同毫秒取后写入的），语义不变但确定
```

## Verified

```text
· server: acked-unconfirmed 5 pass、opencode-sessions-project 6 pass
· agent-node: sessions + v1-shared-read 4 pass（桩泄漏已修，同进程不再污染）
· lint (required) 绿；home-path 基线 no file is above its baseline
· 发版后实测 /health 版本号 + session 投影端点（上线后核对，NOT_RUN 不写「已生效」）
```

## Not verified

```text
· 客户端「新建节点时选已有 Session」的 App 侧链路（依赖 Hub↔daemon 请求通道，本版未含）
· 真实 OpenCode V2 server 上的 sessions 列表端到端（本版只有单测桩）
```
