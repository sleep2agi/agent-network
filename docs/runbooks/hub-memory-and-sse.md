# Runbook — Hub memory spikes and SSE backpressure

**Applies to**: a production `commhub-hub` (pm2) that goes unresponsive for seconds or is
restarted by pm2.
**Born from**: 2026-10-25/26, two `SIGKILL`s at 20:37 and 21:19 plus a measured 2.0–3.6 GB RSS spike.

## 1. First check: was it pm2's own memory cap?

```bash
grep -n "max-memory-restart\|exceeds\|SIGKILL" ~/.pm2/pm2.log | tail -20
```

A line like this means **pm2 killed the Hub**, not the code, not the kernel:

```
[PM2][WORKER] Process 3 restarted because it exceeds --max-memory-restart value
  (current_memory=2331094964  max_memory_limit=2147483648)
App [commhub-hub:3] exited with code [0] via signal [SIGKILL]
```

If `current_memory` is at the limit, see §2. If instead you see a stack trace, it is a code
crash — different problem.

## 2. Give the Hub headroom (30 seconds, no redeploy)

```bash
env -i HOME=$HOME PM2_HOME=$HOME/.pm2 LOGNAME=$USER USER=$USER LANG=C.UTF-8 \
  PATH=$HOME/.nvm/versions/node/v20.20.0/bin:/usr/local/bin:/usr/bin:/bin \
  $HOME/.nvm/versions/node/v20.20.0/bin/pm2 restart commhub-hub --max-memory-restart 6G --update-env
# verify
curl -s localhost:9200/health | head -c 120
```

(`HOME`/`PM2_HOME` are explicit on purpose: a node process's `HOME` must not leak into pm2.)

## 3. Measure, don't guess

Sample RSS + connection counts every minute (read-only; do **not** inject load on a host that
also runs production):

```bash
PID=$(pm2 jlist | python3 -c 'import sys,json;print([a["pid"] for a in json.load(sys.stdin) if a["name"]=="commhub-hub"][0])')
awk '/VmRSS/{print int($2/1024)" MB"}' /proc/$PID/status
curl -s localhost:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["sse_connections"],d["sessions_count"])'
```

What we learned from controlled experiments (isolated Hub + a **copy** of the production DB,
capped with `systemd-run --user --scope -p MemoryMax=2G`):

| workload | effect |
|---|---|
| 150 idle reconnects ×10 rounds | +6.7 MB — **not** the cause |
| 30 concurrent plain HTTP `/health` (2370 req) | RSS flat at 81 MB — **not** the cause |
| SQLite-only inserts 60 rows/s | +17 MB — **not** the cause |
| `send_message` at 18–40 msg/s | 165–199 MB peak — fine |
| `send_message` at **~57 msg/s sustained 60 s** | **2.0 GB → OOM at the 2 GB cap** |

So: the spike is a **sustained message-throughput** phenomenon, not "many SSE clients" and not
"slow SQLite".

## 4. What the Hub already does about it

`server/src/push.ts`:

- per-connection queue is **byte-metered** (`highWaterMark: 0, size: c => c.byteLength`);
- **hard ceiling** `ANET_SSE_MAX_QUEUE_BYTES` (default 1 MB) → closes the stream;
- **stuck timeout** `ANET_SSE_STUCK_CLOSE_MS` (default 30 s) → reaps a connection that is behind;
- since `0.9.0-preview.159`: **degraded subscribers skip non-critical frames** once they are more
  than `ANET_SSE_COALESCE_AT_BYTES` (default 64 KB) behind (counted, never silently swallowed),
  and each broadcast is encoded **once** instead of per subscriber.

Operators can tighten these **without a redeploy**:

```bash
ANET_SSE_COALESCE_AT_BYTES=65536
ANET_SSE_MAX_QUEUE_BYTES=262144
ANET_SSE_STUCK_CLOSE_MS=30000
```

Set them in the pm2 env (or `hub-daemon.sh`) and restart with `--update-env`; then watch RSS while
the traffic pattern is normal.

## 5. When a spike is happening right now

1. Confirm it is the Hub: `curl -m 3 localhost:9200/health` — a timeout with `uptime` still
   increasing means "alive but stalled", not "crashed".
2. Note `sse_connections` and the log write rate (`stat -c %s ~/.commhub/pm2-hub-out.log` deltas) —
   that separates "many subscribers" from "many messages".
3. If the Hub is above your cap and you must act: raise the cap (§2) rather than restart — a
   restart drops 100+ live sessions and every subscriber must reconnect at once.

## 6. Known open item

`ANET-CARD #2363` tracks the remaining question: **which allocation inside the message path grows
with sustained throughput**. Candidates being tested: per-request buffering in the MCP transport,
inbox insert + per-message inbox COUNT, and broadcast serialization under load. Until that is
settled, the 6 GB cap plus the knobs above are the operating envelope.
## 用 `mcp_inflight` 判断“内存尖峰”是哪一类（2026-10-26 起）

Hub `.160` 起 `/health` 多两个键：

```
mcp_inflight       —— 此刻正在处理的 MCP 请求数
mcp_inflight_peak  —— 自进程启动以来的高水位（不衰减）
```

```bash
curl -s http://127.0.0.1:9200/health | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print(d["version"], d["mcp_inflight"], d["mcp_inflight_peak"], d["sse_connections"])'
```

### 为什么会需要它

隔离实测（`.159` + 生产库副本，`systemd-run --scope -p MemoryMax=2G`）：

| 负载 | RSS |
|---|---|
| `send_message` **顺序** 3,255 条/60s（≈54/s） | 151–156 MB **平稳** |
| 50 / 100 / 200 **并发在飞** | 249 / 446 / 689 MB |
| `get_inbox` 50 / 100 并发 | 268 / 405 MB（与 `send_message` 同形） |

⇒ RSS 跟着**在飞请求数**走（≈1.2–1.4 MB/条），不跟吞吐、也不跟某个具体工具走。
`sse_connections` 只看得见**长连接**，看不见“同秒打进来的一批短请求”。

### 三类尖峰怎么分

| 观察 | 判断 | 处置 |
|---|---|---|
| `inflight` 与 `peak` 同时抬，`peak` 出现在**重启/部署后 1 分钟内** | **重连风暴**（几百个节点/客户端同时重连） | 让重连错峰（node `.164` 起 `firstRetrySpreadMs=8s`），**不要**在风暴里加 429（会让重试放大风暴） |
| `inflight` 长时间维持在几十上百，`peak` 持续抬高 | 真的有慢请求/慢 SQL 在堆积 | 找慢接口：同步 SQLite 写与重查询是常见来源；必要时才考虑入口限流 |
| `inflight` 平稳但 RSS 缓慢单调上涨 | 泄漏（缓存/连接/编码器） | 按对象排查；与限流无关 |

### 一次真实读数（`.160` 上生产后第一分钟）

```
重启后  59s:  mcp_inflight 0 | mcp_inflight_peak 308 | sse 150 | sessions 367
重启后 102s:  mcp_inflight 0 | mcp_inflight_peak 308 | sse 150
```

308 × 1.3 MB ≈ 400 MB —— 这正是“夜里 RSS 突然到 450 MB 又回落”的量级，而稳态 `inflight = 0`。

### 读 RSS 时不要读错进程（踩过）

```bash
# ❌ 错：ss 拿到的常常是包装/父进程
ss -ltnp | grep 9200 | sed 's/.*pid=\([0-9]*\).*/\1/'

# ✅ 对：按监听端口反查 socket inode，再找持有它的进程
python3 - <<'PY'
import os
port_hex = "%04X" % 9200
inodes = {r.split()[9] for r in open('/proc/net/tcp').read().splitlines()[1:]
          if len(r.split()) > 9 and r.split()[1].endswith(':'+port_hex) and r.split()[3] == '0A'}
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try:
        for fd in os.listdir(f'/proc/{pid}/fd'):
            t = os.readlink(f'/proc/{pid}/fd/{fd}')
            if t.startswith('socket:[') and t[8:-1] in inodes:
                for line in open(f'/proc/{pid}/status'):
                    if line.startswith('VmRSS:'):
                        print(pid, int(line.split()[1]) // 1024, 'MB'); raise SystemExit
    except OSError:
        pass
PY
```

用错进程的代价：我曾长期把生产 RSS 汇报成 340–410 MB，实际是 **246–277 MB**（偏高约 80–100 MB）。
**读到了数字 ≠ 读对了进程**——第一次用某个指标前，先 `readlink /proc/<pid>/exe` 确认身份。

### 采样命令（只读，12 小时）

```bash
setsid nohup python3 /tmp/opencode/inflight-watch.py /tmp/opencode/inflight-160.tsv 43200 30 &
```

## 卡顿归因：先分清「受害者」与「凶手」（2026-10-26 起，`.162` 补齐）

2026-10-26 21:55–22:12 生产出现两次尖峰（RSS 3.6 → 4.5 GB，`mcp_inflight` 387 → 807）。
当时手上有三样东西，但**没有一样能指出“谁在卡”**：

| 证据 | 能回答 | 不能回答 |
|---|---|---|
| `mcp_inflight` / `peak`（`.160` 起） | 有多少请求在**排队** | 谁把它们堵住的 |
| `GET /api/stats/routes` 的 `max_ms` | 哪个请求**受害**了 | 它的耗时里有多少是排队 |
| 日志行的时间戳 | 什么时候停过（**单线程 ⇒ 日志静默 = 阻塞**） | 阻塞的是哪段代码 |

第三条是当时唯一能定性的一条：按日志时间戳找 ≥10 秒的静默，就得到 14/22/28/47 秒的四次停顿。
其中最规整的一次每小时出现（`18:11`、`19:11`、`21:46`），且每次静默后都紧跟一行
`[commhub retention] swept in 8331/9863/10588ms`。

### `.162` 起多两条直接证据

```bash
# 1) 停顿本身：最大 tick 间隔 + 最近 20 次停顿（含当时 RSS）
curl -s localhost:9200/health | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["event_loop"],indent=2,ensure_ascii=False))'

# 2) 慢 SQL（>1s 才打，默认阈值 1000ms；COMMHUB_SLOW_SQL_MS=0 关闭）
grep "commhub slow-sql" ~/.commhub/pm2-hub-out.log | tail -5
```

判定顺序（照这个顺序问，能省掉大部分猜测）：

1. `event_loop.recent_stalls` 有没有对应时间点？
   - **没有** ⇒ 不是事件循环阻塞（想想客户端慢、网络、GC 之外的进程外因素）。
   - 有 ⇒ 记下 `stall_ms` 与 `rss_mb`。
2. 同一时间点有没有 `[commhub slow-sql]`？
   - 有 ⇒ 就是那条 SQL。先 `EXPLAIN QUERY PLAN` 看是不是全表扫（今天的例子：`agent_telemetry` 三个复合索引都以 `network_id` 打头，而删除语句只按 `created_at` ⇒ 每小时扫 62 万行）。
   - 没有 ⇒ 是 JS 里的同步块（同步文件 IO、超大 `JSON.stringify`、同步压缩），不是数据库。
3. 两条都没有、但 RSS 很高 ⇒ 才轮到怀疑运行时/GC。**不要**在没排除 1、2 之前谈 GC。

### 一条被排除的候选：上传

`/api/stats/routes` 里 `POST /api/upload` 当天最慢 **178 s**、p95 52 s，看起来很像元凶。
但它是**受害者**：耗时 = 客户端上行时间。隔离实测 12 MB 上传在本机磁盘上 **41–70 ms**，
并且上传后内存立即回落，撑不起 4.5 GB。**路由耗时里含排队时间，别拿它当“服务端慢”的证据。**

### 一次真实的归因样例（保留过程，不删）

```
21:59  /health 首次超时（6s）
22:02  RSS 3588 MB  inflight 387  peak 662   /health 最慢 13.2s
22:06  回落 280 MB
22:10  RSS 4502 MB  peak 807                 ← 第二次比第一次更高
```
两次都**没有重启**、也没有触发 6 GiB 上限。把它们与日志静默对齐后，得到两条不同性质的结论：
一条是 retention 的索引缺失（可修，已修），另一条是至今未定性的 14–47 秒随机停顿。
**把两件事分开记，比合成一个“Hub 不稳”的结论有用得多。**
