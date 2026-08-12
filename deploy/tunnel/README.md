# 公网入口:frp 隧道与 Caddy

对应 issue #707。补的是灾难重建规则里的一条缺口:**照当时的 repo,
你能把 dashboard 进程跑起来,但配不出任何一个公网入口。**

## 拓扑

```
公网 ─┬─ Caddy  :3000  ──TLS 终结──┐
      │                            ├──►  127.0.0.1:3001  (Next.js, pm2 托管)
      └─ frpc   :3100 ─────────────┘

      frpc 另外还转:  公网 :222 → 本机 :22 (SSH)
                      公网 :9300 → 本机 :9200 (CommHub)
```

🔴 **公网入口不止一个。** 这是最容易判断错的一层 —— 见 `frpc.example.toml` 顶部注释里记的那次误判。

## 重建步骤

1. 装 `frpc`(与 frps 服务端**大版本一致**),放 `/usr/local/bin/frpc`
2. `cp frpc.example.toml ~/.frp/frpc.toml`,填 `FRP_SERVER_ADDR` / `FRP_AUTH_TOKEN`
3. 起进程:`frpc -c ~/.frp/frpc.toml`(建议交给 systemd 或 pm2,别裸跑)
4. Caddy:把 `caddy.example` 的片段填好域名后并入 `Caddyfile`,`caddy reload`
5. 验证:两个入口都能取到同一份静态文件,且 `Last-Modified` 相同

## 密钥

`FRP_SERVER_ADDR` 与 `FRP_AUTH_TOKEN` **不入库**。
只记录名称与获取方式:向部署属主索取,或从密钥库读取;轮换时两端同步更新。

## 未演练

**尚未在空机上从零走过这套流程。** 按 `AGENTS.md` 第 19 节的口径,
在隔离环境演练并把证据记进 `docs/tests/` 之前,**不得宣称"可恢复"** ——
这份文档目前的地位是「已知正确的操作手册」。
