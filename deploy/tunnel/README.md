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
3. 起进程 —— **unit 已在仓里**,不要自己现编:

   ```bash
   sudo install -m 644 deploy/tunnel/frpc.service /etc/systemd/system/frpc.service
   sudo systemctl daemon-reload && sudo systemctl enable --now frpc
   systemctl show frpc -p MainPID -p ActiveState -p UnitFileState   # 期望 active + enabled
   ```

   (`frpc.service` 只含 `ExecStart` 与配置文件路径,**不含任何凭据** ——
   凭据在 `~/.frp/frpc.toml` 里,见下方「密钥」一节。)
4. Caddy:把 `caddy.example` 的片段填好域名后并入 `Caddyfile`,`caddy reload`
5. 验证:两个入口都能取到同一份静态文件,且 `Last-Modified` 相同

## 密钥

`FRP_SERVER_ADDR` 与 `FRP_AUTH_TOKEN` **不入库**。
只记录名称与获取方式:向部署属主索取,或从密钥库读取;轮换时两端同步更新。

## 🔴 第二个 frpc:visitor(**当前 NOT COVERED,且跑在 /tmp**)

本机上除了上面那个 systemd 托管的 frpc,还有**第二个**:

```
./frpc -c ./frpc-visitor.toml
  cwd    /tmp/frp_0.61.1_linux_amd64          ← 在 /tmp
  父进程  一个普通 bash,不是 systemd / pm2   ← 没有 supervisor
  启动于  2026-07-17                          ← 已这样跑了很久
```

配置是 frp 的 `[[visitors]]` 段(`type` / `serverName` / `bindAddr` / `bindPort` /
`secretKey` 等键)。

**为什么这条要单独写出来:**

- 它**不受任何 supervisor 管**,进程没了不会自愈;
- 它跑在 `/tmp` —— **任何 `/tmp` 清理都会连二进制带配置一起删掉**,
  而且因为用的是相对路径,连重启命令都不再有效;
- 本文件此前**完全没提它**,拓扑图里也没有 —— 仅凭本仓重建不出这一条通路。

**本条只是登记现状,没有改动它**(改动它属于生产变更)。
补齐之前,「仅凭 repo 重建公网入口」对这条通路**不成立**。

## 未演练

**尚未在空机上从零走过这套流程。** 按 `AGENTS.md` 第 19 节的口径,
在隔离环境演练并把证据记进 `docs/tests/` 之前,**不得宣称"可恢复"** ——
这份文档目前的地位是「已知正确的操作手册」。
