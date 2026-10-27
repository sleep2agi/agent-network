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

### retention 那次停顿的修法（#2614，`0.9.0-preview.168` → `.169`）

每小时一次 `swept in 8–11s` 的静默，根因不是“删得多”，而是**一次 DELETE 把整批行放在同一个语句里，
中间不让出事件循环**。现在：

```
每批 ≤ COMMHUB_RETENTION_CHUNK_ROWS（默认 2000）行
  → DELETE … WHERE rowid IN (SELECT rowid FROM t WHERE <谓词> LIMIT n)   ← 索引驱动
  → 每批之间 await 一次 setTimeout(0)，把控制权交还事件循环
  → 删的这段时间关掉 WAL 自动 checkpoint，本轮 checkpoint 收敛到末尾那一次 TRUNCATE
  → 单表最多跑 10 分钟；超了记 truncated 并下一轮继续
  → 同一时刻只允许一轮 sweep（上一轮没跑完就跳过这一拍）
```

**两条是被副本实验逼出来的，第三条是被生产打回来的**：

| 写法 | 合计 | 最长单次阻塞 | 结论 |
|---|---|---|---|
| 一次 DELETE（旧） | 3.1 s | 2686 ms | 不可打断 |
| 分批 + 每批重新子查询（无索引副本） | 17 s | 4634 ms | 每批全扫，**更糟** |
| 分批 + rowid 游标（无索引副本） | 5.4 s | 281 ms | 副本上很好 |
| **分批 + rowid 游标（生产）** | 6.2 s | **4716 ms** | 🔴 打回：见下 |
| 分批 + 索引驱动 `LIMIT n`（现状） | 1.8 s | 249 ms | 生产副本实测（当前 schema） |

**第一条教训（索引缺失）**：`created_at < ?` 若没有可用索引，子查询会退化成覆盖索引扫描，
于是「每批从表头扫一遍」，总代价 = 批数 × 表大小。

**第二条教训（checkpoint）**：自动 checkpoint 是连接级、每 1000 页触发的，会落进任意一批，
实测把中位数 89ms 的批次顶到 4.3 秒 ⇒ **分批必须配「自己决定何时 checkpoint」**。

**第三条教训（我的副本过期了）**：`.168` 上线第一拍的生产日志是

```
[commhub slow-sql] 4716ms SELECT rowid … WHERE created_at < ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3
[commhub retention] swept in 6157ms (3 batches) — telemetry=266
```

只删 266 行却花了 4.7 秒。原因是我用的副本是 **10-26 的快照**，那时 `agent_telemetry`
还没有 `idx_agent_telemetry_created`（#3065 之后才加的）。现在生产上谓词本来走索引范围，
但 `ORDER BY rowid` 把计划改成了 `INTEGER PRIMARY KEY` 从 rowid=0 一路扫完 60 万行。

⇒ 结论：**副本实验必须先确认副本 schema 与生产一致，否则“优化”会变成新的全表扫。**
一并验证了各表在**生产**上的真实计划：

```
agent_telemetry  SEARCH … USING COVERING INDEX idx_agent_telemetry_created
task_events      SEARCH … USING COVERING INDEX idx_task_events_created
tasks            SEARCH … USING INDEX idx_tasks_status
audit_log        SEARCH … USING COVERING INDEX idx_audit_created
inbox            SCAN（没有谓词索引）→ 每小时可删行很少，一轮只有一批，代价可忽略
```

验证（每小时整点后）：

```bash
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -3
#   期望 /   swept in <2000ms (N batches, max <300ms)
#   不得再出现 /  [commhub slow-sql] … SELECT rowid …   ← 出现就是又退化成全表扫了

curl -s localhost:9200/health | python3 -c 'import sys,json;e=json.load(sys.stdin)["event_loop"];print(e.get("max_gap_ms"),e.get("stall_count"))'
```

**取舍**：分批 + 让出会让总耗时略增（可被打断优先）。一次 10 秒不可打断的停顿，
代价是 800 个请求在飞和 4.5 GB RSS。

## 别把「日志行数」当「请求数」（2026-10-27 15:46 的一次误读）

诊断一次 4.1 秒停顿（`served 126 req`）时，我先按秒统计日志行，得到「15:46:38 一秒 123 行」，
第一反应是“几百个节点在同一秒打进来”。逐行看才发现：

```
15:46:45: [15:46:45] TMAI文档欧 (sdk-n_81) → report_status: working | 先推进 TMAI 的文档优化和维护
15:46:45:                                  ← 同一条消息的续行，也被单独计了一行
15:46:45: 同时拉取 Hub 相关的文档优化的任务，承接文档优化的任务，你也可以自己去拆解创 [net]
```

**一条多行任务文本会变成十几行日志。** 所以：
| 想要的数 | 该用哪个 |
|---|---|
| 每秒**请求数** | `/health.mcp_inflight` 或 `served` 计数（服务端计数器） |
| 每秒**日志行数** | 只适合看“日志有没有静默”，**不能反推并发** |
| 心跳是否同秒对齐 | 只统计 `→ <tool>:` 的行（单行工具调用），不要统计续行 |

这条和上面「阻塞 vs timer 饥饿」配套：`served>0` 说明循环在干活（回调密集 ⇒ timer 饥饿），
`served=0` 才是真同步阻塞。**行数两种都不说明。**

## 部署自己也是负载（2026-10-27，一天里踩了三次）

同一天里，有三段「看起来很糟」的数字，最后都归因到**部署/启动本身**，而不是产品缺陷：

| 现象 | 表面结论 | 真实原因 | 判据 |
|---|---|---|---|
| 启动后 2.7 s 卡顿 | 回填写得太慢 | 回填在**重连风暴期间**跑 | 对齐 `deferred boot backfills` 与 SSE 重连时间戳 |
| 每小时 10 s 静默 | retention 删得太多 | 一次 DELETE 不可打断 | 分批 + 让出（`#2614`） |
| 部署后 retention 15.7 s / 4.2 ms 行 | 分批失效了 | 首次 sweep 与**启动风暴抢 CPU/WAL**（稳态 0.24 ms/行） | 同一批删除在稳态的耗时作对照 |

### 三条可复用的判据

1. **任何“变慢了”的结论，先问“它是不是和部署同时发生”**。启动后 60 秒内的任何指标都不可信：
   重连风暴的 `served` 可达 600+，RSS 从 500 MB 冲到 1.4 GB。
2. **用“每行/每条”的单价做对照**，不要用总时长。总时长受并发影响，单价能立刻分出
   「语句变慢」和「环境变慢」（4.2 ms/行 vs 0.24 ms/行 ⇒ 环境）。
3. **启动期的工作要主动避开风暴**：回填有 `COMMHUB_BOOT_BACKFILL_DELAY_MS`，
   首次 retention 有 `COMMHUB_RETENTION_FIRST_DELAY_MS`（默认 60 秒）。

## 两种"看起来一样、处置相反"的现象：阻塞 vs timer 饥饿（2026-10-27 起）

`.162` 的停顿监测上线后第一批数据就踩到一个坑，值得写死：

```
2026-10-27 00:39:47  gap 84887ms  rss 2076 MB
2026-10-27 00:39:56  gap  9549ms  rss 2432 MB
```

只读这两行会得出"事件循环被阻塞了一分半"，而**同一时段日志在正常写**（00:38:52 / 00:38:58 / 00:39:08），
`/api/stats/routes` 里最慢的请求只有 **2.4s**。所以循环没有被阻塞，是 **timer 回调被 I/O 回调饿住**。

| 判据 | 含义 | 处置 |
|---|---|---|
| 该间隔内 **0 个请求**完成 + `[commhub slow-sql]` 有记录 | 真正的同步阻塞 | 找同步块 / 慢 SQL |
| 该间隔内 **>0 个请求**完成 + 日志照常 | timer 饥饿（高并发/大批回调） | 降瞬时并发（广播扇出、重连错峰）；**加内存无用** |

`.163` 起每 tick 记录 `requests_since_last_tick`，日志写成 `loop idle ~Nms (… served M req)`。

**触发形态（实测）**：一次 broadcast 扇出 → 一分钟 380 次调用（基线 ~110）→ `inflight` 622 → RSS 2.6 GB。
广播类操作要按"扇出规模"看待，不要按"一条消息"看待。

## 副本能量执行计划，量不出生产速度（2026-10-27）

同一个 `UPDATE … FROM` 语句：

```
生产库副本（sqlite3 直接执行，自动提交）      0.29 s
生产进程（启动事务 + WAL + 369 会话重连中）   1.51 s
```

行数一样（84,062 vs 84,260）、索引一样、`EXPLAIN QUERY PLAN` 一样 —— 差的是**事务边界与并发环境**。

⇒ 报告里凡是要说"从 X 秒降到 Y 秒"，**Y 必须来自生产**；副本只用来证明"执行计划对了"。
写发布说明同理：`.162` 曾写"retention 应到亚秒级"，实测 1.2–1.3s（剩下的是删一行要维护 4 个索引），
更正写进了 `.163` 的说明里。
