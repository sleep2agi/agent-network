# 跑 `daemon-provider-snapshots.test.ts` 的三个前置

这份记录只有一件事：那 6 条测试在本机全红、在 CI 全绿，而**红的原因不在代码里**。
下次看到它们红，先照这里走一遍，再去怀疑实现。

## 症状（2026-11-01 实测，本机）

```
bun test ./src/daemon-provider-snapshots.test.ts
  => 11 pass / 6 fail
```

红的六条都是「要 spawn 真 CLI」的那一类：

```
saved ChatGPT account binding traverses Hub and compiled daemon CLI
managed login: admin intent → capable target daemon → session manager
write core chain: encrypted Hub request → target daemon CLI → durable replay
collection core chain: bound source → capable daemon CLI → durable replay
daemon reconnection executes actual pinned CLI against private store
real HTTP authentication → daemon handler → pinned CLI → scoped public receipt
```

## 三个前置（按报错出现的先后）

### ① 钉住 CLI 的绝对路径

```
anet_bin_unsafe_path: no ANET_BIN_ABS resolved from /etc/anet-daemon/path.conf
```

写一份自己拥有的 pin 文件，用 `ANET_DAEMON_PATH_CONF` 指过去：

```bash
printf 'ANET_BIN_ABS=%s\n' "$REPO/agent-network/dist/bin/anet.cjs" > /tmp/anetpin/repo.conf
export ANET_DAEMON_PATH_CONF=/tmp/anetpin/repo.conf
```

### ② 路径必须是包内 `bin.anet` 指向的那个文件

```
anet_bin_unsafe_path: not an anet package bin: package.json bin.anet does not point at …/dist/bin/cli.js
```

`agent-network/package.json` 的 `bin.anet` 是 `dist/bin/anet.cjs`（一个 CJS 垫片），
**不是** `dist/bin/cli.js`。所以 pin 要指向垫片：

```bash
cd "$REPO/agent-network"
bun run build          # 或至少：
bun build bin/cli.ts --outdir dist/bin --target node --minify \
  --external @sleep2agi/commhub-server --external bun:sqlite --external "../../server/*"
cp bin/anet.cjs dist/bin/anet.cjs
```

### ③ pin 的 CLI 必须**不旧于**本仓

这是那 6 条的真实成因，也是最难从报错里看出来的一个：

```
本机全局装的是 anet v2.3.0-preview.143，而本仓是 2.3.0-preview.206
143 没有 `daemon provider` 子命令 ⇒ 子进程吐出 usage ⇒ 测试收到 provider_snapshot_unavailable
```

`provider_snapshot_unavailable` 读起来像「Hub 侧的 provider 快照功能坏了」，
而其实是「被 pin 的那个可执行文件不认识这个子命令」。**报错说的是症状，不是位置。**

另有一条容易踩的：全局装的 `anet.cjs` 若 `go+w`（实测 775），会被安全检查拒绝
（`writable by group/other`）——这也不是代码问题。

## 通过时的读数

```
ANET_DAEMON_PATH_CONF=/tmp/anetpin/repo.conf bun test ./src/daemon-provider-snapshots.test.ts
  => 17 pass / 0 fail（170 expect）
```

## 为什么值得写下来

那 6 条覆盖的正是「切换 → 校验 → 下发 → 回读」这条链（写入核心链、
daemon 重连、超时显式、密钥不落库、真实 HTTP 鉴权）。它们红着的时候，
**看起来像这条链坏了**；而链是好的，坏的是我拿了一份旧的 CLI 去跑它。
