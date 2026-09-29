# RFC-039: Hub 支持 PostgreSQL(与 SQLite 并存,可选)

- 状态:草案(2026-09-30)
- 提出:通信龙。需求原话(Vincent):「Hub 支持 PG 数据库兼容 ，新需求 优先级低」
- 范围:hub(commhub-server)的数据库层、CI、一个离线数据迁移工具。**SQLite 仍是默认后端**,不设 `DATABASE_URL` 的部署行为一字不变。
- 证据基准:`origin/main` @ `f57e17b3`(实测时为 `a09cf3c5`,两者之间 `server/src` 无改动)。下文的行号、计数、实测都以此为准。

## 0. 结论先行

代码里**有** PostgreSQL 入口,但它今天**起不来**:

- 设了 `DATABASE_URL=postgres://…` 的 Hub,在建表的**第一条语句**就崩(实测,见 §1.3)。
- 就算把建表修好,`startHub()` 也会主动拒绝在 PG 上启动(定时任务要求事务,而 PG 适配器的事务是假的)。
- 修掉这两处、强行跑到登录/派活/回复,会暴露出第三层:时间列类型、整数宽度、`COUNT` 返回字符串、参数类型推断,以及**非原子的事务**(回复把任务写成 `replied`,却给调用方返回报错)。

根因只有一个:`DbAdapter` 是**同步**接口(全仓 811 处调用),而 PG 驱动是异步的,现有实现用「每条 SQL 起一个 `node -e` 子进程」来桥接。这个桥**既慢(约 0.4 s/条)又没有事务**。本 RFC 的核心建议是:**保留同步接口,把桥换成「常驻 Worker + 一条保留连接 + `Atomics.wait`」**——实测 1 ms/条、`ROLLBACK` 真的生效(§3.1)。其余都是可以逐条收敛的方言差异。

拆成 5 个可以单独发版的小步(§8)。第 1 步不改任何生产代码路径。

## 1. 现状(带证据)

### 1.1 代码路径

| 位置 | 内容 |
|---|---|
| `server/src/db-adapter.ts` `resolveDatabaseTargetAfterGuard()` | `DATABASE_URL` 以 `postgres://` / `postgresql://` 开头 → `PgAdapter`;否则 SQLite(`COMMHUB_DB` 或默认路径) |
| `server/src/db-adapter.ts` `assertSafeTestDatabaseEnv()` | `NODE_ENV=test` 下只要继承了 `DATABASE_URL` 就拒绝启动,**没有旁路**(test637 用 strace 证明它先于任何 connect) |
| `server/src/db-adapter.ts:140` `PgAdapter.querySync()` | 每条 SQL:`Bun.spawnSync(["node","-e", …])`,子进程里 `new Pool({max:1})` → 一条查询 → 退出 |
| `server/src/db-adapter.ts:195` `PgAdapter.transaction()` | `BEGIN` / 函数体 / `COMMIT` 各自在**不同子进程、不同连接**上执行;类注释自己写着 `TODO(P0-4): this is not transaction-safe` |
| `server/src/db-adapter.ts` `sqliteToPostgres()` | 正则翻译:`?N→$N`、`datetime('now'…)→NOW()…`、`AUTOINCREMENT→SERIAL`、`TEXT NOT NULL DEFAULT (NOW())→TIMESTAMP …` |
| `server/package.json` | **没有** `pg` 依赖。只有 test637 的 Docker 镜像装了 `pg@8.16.3` |
| `agent-network/src/bootstrap-password-db.ts` | `anet hub start` 的管理员引导遇到 PG 直接拒绝(「REFUSING SQLite bootstrap update for a PostgreSQL Hub」) |

已有的方言分支(说明以前有人按 PG 写过一部分):

| 位置 | PG 分支做什么 |
|---|---|
| `db.ts` `migrateNodeCreateRequestsModelNullable` / `migrateUserInboxNetworkIdNotNull` / sessions 网络唯一键迁移 | 用 `ALTER COLUMN` 代替 SQLite 的整表重建 |
| `db.ts` `task_terminal_events` | SQLite 用 `CREATE TRIGGER … INSERT OR IGNORE`;PG 用 plpgsql 函数 + 触发器 |
| `requirements-migrate.ts` | `DROP/ADD CONSTRAINT` 代替重建 |
| `scheduled-tasks.ts:59` `assertScheduledTaskBackendSupported()` | **拒绝**:`scheduled_tasks_require_transactional_sqlite_backend`,由 `server.ts:4177` 在 `startHub()` 里、监听端口之前调用 |
| `tools.ts:1310`(任务运行证据批量写) | **拒绝**:`task_runtime_evidence_backend_unsupported` |
| `side-thread-command-transport.ts:53` | **拒绝**:构造即抛 |

对外口径一致:`docs-site/docs/troubleshooting.md`「支持 PostgreSQL 吗?」和 `concepts/security.md`「数据库安全」都写明「未做端到端验证、不建议生产使用」。

### 1.2 测试与 CI

- **没有任何 CI job 连过真 PostgreSQL。**`.github/workflows/` 里唯一提到 postgres 的是 `qa.yml` 中 test661 的注释(`postgres-invents-sqlite` 变异)。
- 与 PG 有关的测试**全部是「不许连 PG」方向的守卫**:`db-adapter-guard.test.ts`(纯函数选路)、test637(strace 证明测试环境下不 connect)、test638(聚合测试不继承 `DATABASE_URL`)、test661(CLI 不许把 PG 配置偷换成 SQLite)。
- `scheduled-tasks-http.test.ts:95` 把 `db.dialect` 改成 `"postgres"` 来测拒绝分支——也是拒绝方向。
- 没有 `sqliteToPostgres()` 的单元测试。

### 1.3 实测:把 Hub 接到真 PostgreSQL 上

Docker 里 `postgres:16-alpine` + `oven/bun:1.3.14` + `pg@8.16.3`,一次性容器、非 9200 端口,不碰任何宿主机状态。每一轮在容器内给适配器打一个**仅限探针**的补丁,看下一处在哪里断:

| 轮 | 结果 | 原因 |
|---|---|---|
| 0(原样) | 4 s 后退出,建出 2 张表 | `syntax error at or near "desktop"`:`exec()` 按 `;` 切语句,`db.ts:62` 的 SQL 注释里有个 `;` |
| 1(切句前去掉 `--` 注释) | 46 s,18 张表 | `type "blob" does not exist`(`network_secrets` 三列 `BLOB`,`db.ts:884`) |
| 2(`BLOB→BYTEA`) | 76 s,29 张表 | plpgsql 函数体被按 `;` 切碎(`db.ts:1472`) |
| 3(含 `$$` 的整段发送) | 79 s | `COALESCE types text and timestamp … cannot be matched`:翻译器把 33 个 `TEXT NOT NULL DEFAULT (datetime('now'))` 列变成 `TIMESTAMP`,而 `tasks.completed_at` 这类不带默认值的 `*_at TEXT` 列(24 个)还是 `TEXT`,两类混用就报错 |
| 4(时间一律保持 SQLite 文本格式,见 §4.1) | 96 s,**38 张表,建表完成** | `scheduled_tasks_require_transactional_sqlite_backend`(`startHub()` 主动拒绝) |
| 5(绕过该门,只在探针里) | 约 100 s 后 `/health` 200 | 见下 |

第 5 轮的业务探针(注册 → 登录 → 建网络 → 签节点令牌 → `report_status` → `POST /api/task` → `send_reply`):

| 步骤 | 结果 | 耗时 |
|---|---|---|
| 注册首个用户 | 200,但 **`role:"user"`**——首个用户本该是 `admin` | 3.9 s |
| `report_status` | ok,但 `inbox_count` 是字符串 `"0"` | 7.7 s |
| `POST /api/task` | ok | 11.6 s |
| `send_reply` | 第一次:`COALESCE types text and timestamp with time zone`(`db.ts:1478` 手写的 `NOW()`,翻译器不管) | — |
| `send_reply`(补上后重跑) | **任务已写成 `replied`、终态事件也写了,但工具返回 `could not determine data type of parameter $2`** | 10.8 s |

后台 sweeper 另报三类错:`value "1788128772451" is out of range for type integer`(毫秒时间戳写进 `INTEGER` 列)、`PRAGMA` 语法错(retention)。PG 服务端日志里出现 `WARNING: there is no transaction in progress`——`COMMIT` 发在了和 `BEGIN` 不同的连接上,这是 §1.1 那条 TODO 的直接证据。

最后一行最要紧:**同一次调用里,前几条写入已经落库,后一条失败,调用方拿到的是报错**。这就是非原子事务在真实流程里的样子,也是那三处「拒绝」分支存在的原因。

## 2. 差距清单(按严重程度)

计数方法:`server/src` 下非测试的 `.ts`(递归,58 个文件),`grep -F`;先拿 `db-adapter.ts` 里已知的 `datetime('now')`(3 处)做阳性对照。

### 2.1 阻断级(不修就不能用)

| # | 差距 | 规模 | 证据 |
|---|---|---|---|
| B1 | 同步桥:每条 SQL 一个子进程,约 0.4 s/条;事务不共享连接 | 全部 811 处调用(`db.run` 282 / `db.get` 263 / `db.all` 82 / `db.exec` 136 / `db.transaction` 48) | §1.3 耗时列、PG 日志 WARNING |
| B2 | `exec()` 按 `;` 切句:不认注释、不认 `$$` | `db.exec` 136 处,任何一处注释带 `;` 就断 | 第 0、2 轮 |
| B3 | 时间列类型分裂:`DEFAULT (datetime('now'))` 被译成 `TIMESTAMP`,其余仍是 `TEXT` | 33 个列被改成 `TIMESTAMP`,24 个 `*_at TEXT` 列没改;`datetime(` 137 处 | 第 3 轮、`send_reply` 第一次 |
| B4 | 整数宽度:毫秒时间戳存在 `INTEGER` 列(PG 是 32 位) | 53 个 `*_at INTEGER` 列 | sweeper 报错 |
| B5 | `COUNT(*)` 等 `int8` 结果以字符串返回;`=== 0` 恒假 | `COUNT(` 46 处;已知 `auth.ts:77`、`auth.ts:756` 两处严格比较 | 首个用户不是 admin;探针里把 int8 解析成数字后变回 admin(见 `docs/tests/report-test2123.txt`,#2125) |
| B6 | `startHub()` 在 PG 上拒绝启动;另两处功能拒绝 | 3 处 | `server.ts:4177`、`tools.ts:1310`、`side-thread-command-transport.ts:53` |
| B7 | 驱动不在依赖里 | `server/package.json` 无 `pg` | §1.1 |

### 2.2 功能级(能起,但某些路径错)

| # | 差距 | 规模 | 处置 |
|---|---|---|---|
| F1 | 参数类型推断:`?N IS NULL OR col = ?N` 在 PG 上无法推断类型 | 2 处 | 显式 `CAST(?N AS TEXT)` |
| F2 | `BLOB` | 3 列(`network_secrets`) | 翻译为 `BYTEA`;读出来是 `Buffer`,与 bun:sqlite 的 `Uint8Array` 对齐需在适配器里转 |
| F3 | `rowid` 作为排序兜底 | 3 处(`tools.ts:3093`、`human-dm.ts:130`、`side-thread.ts:591`) | 换成主键或显式自增列 |
| F4 | `PRAGMA` 走 `get()` 时适配器不拦 | `retention.ts:207/219–221` | retention 的 WAL/vacuum 段按方言分支,PG 上交给 autovacuum |
| F5 | `strftime('%Y-%m-%d %H:%M:%f','now')` | 1 处(`human-dm.ts:78`) | 翻译器加一条 |
| F6 | `LIKE` 大小写:SQLite 对 ASCII 不区分,PG 区分 | 18 处 | 逐条看是否依赖不区分;需要的译为 `ILIKE` |
| F7 | `INSERT OR IGNORE` / `INSERT OR REPLACE` | 3 + 1 处,**全在已有的 SQLite 分支里** | 无需改;加一道门防新增 |
| F8 | `sqlite_master` | 6 处,**全在已有的 SQLite 分支里** | 同上 |
| F9 | `AUTOINCREMENT` | 3 张表 | 已译为 `SERIAL`;改为 `BIGSERIAL`,迁移工具要 `setval` |

### 2.3 已经兼容、不用动

`ON CONFLICT … DO UPDATE/NOTHING`(16 处,含 `excluded.`)、部分唯一索引(`CREATE UNIQUE INDEX … WHERE`,6 处)、`COALESCE`、`||`。`json_extract` / `json_each` / `GROUP_CONCAT` / `IFNULL` / `last_insert_rowid` / `RETURNING` 均为 0 处。

## 3. 方言策略:保留同步接口,换掉桥

### 3.1 为什么不改成异步

把 `DbAdapter` 改成 `Promise` 意味着 811 处调用和它们所在的每个处理函数都要改成 `async`,并且 SQLite 路径也跟着变——这违背「SQLite 行为一字不变」。更重要的是,Hub 今天**依赖**「同步 = 事务内不会被别的请求插进来」这件事(bun:sqlite 本身就是同步阻塞的);改成异步后,事务中间的 `await` 会让别的请求交错进来,需要重新审每一个事务的隔离假设。

**建议:同步接口不动,把子进程桥换成常驻 Worker。**

- 主线程:`postMessage(sql, params)` → `Atomics.wait` 阻塞到 Worker 写回结果(共享内存)。
- Worker:`Bun.SQL`(Bun 自带的 PG 客户端,不需要 `pg`、不需要 `node`)`reserve()` 一条**专用连接**,所有语句都在这条连接上执行 → `BEGIN/COMMIT/ROLLBACK` 自然是真事务。
- 语义与 SQLite 等价:主线程一次只有一条语句在飞,事务期间别的请求进不来。

可行性 spike(Docker,`oven/bun:1.3.14` + `postgres:16-alpine`,约 40 行):

| 量 | 结果 |
|---|---|
| 1000 条同步 `INSERT` | 1035 ms,**约 1 ms/条**(现桥约 400 ms/条) |
| `BEGIN; INSERT; ROLLBACK` 后查 | 0 行 —— 回滚真的生效 |
| `COUNT(*)` 返回类型 | `string` —— B5 在新桥上依然存在,要在适配器里统一转 |

代价:Hub 的吞吐上限等于「单连接串行」,和 SQLite 今天一样;不比现在差,也不会因为换 PG 变快。需要多连接并发是另一个问题,不在本 RFC 范围。

### 3.2 翻译层

继续「调用方写 SQLite 方言、适配器翻译」,不引入 ORM / 查询构建器(那是 811 处重写)。翻译器要改的:

1. `exec()`:整段脚本作为**一次 simple query** 发给 PG(PG 原生支持多语句,注释与 `$$` 由服务端解析),不再自己切句。
2. 时间:见 §4.1。
3. DDL:`INTEGER → BIGINT`、`AUTOINCREMENT → BIGSERIAL`、`BLOB → BYTEA`。
4. `strftime` 那一种写法。
5. 结果归一:`int8` 在安全整数范围内转 `number`;`BYTEA` 转 `Uint8Array`。

每条规则配单元测试(纯函数,不连库),再由 §6 的真库套件兜底。**正则翻译的边界要写清楚**:它只认识仓里实际出现的形状;新写法落不进去时应该在真库套件里红,而不是静默翻错。

### 3.3 连接与连接池

- 一条保留连接(见 3.1);`max:1`。
- 启动时 `SET TIME ZONE 'UTC'`、`statement_timeout`(默认 30 s,环境变量可调)。
- 连接断开:Worker 重连;**事务进行中断开 → 抛错、不重试**(重试会把半个事务重放)。
- 连接串只从 `DATABASE_URL` 读,日志里脱敏(只打 host/db,不打口令)。

## 4. Schema 与迁移

### 4.1 时间列:PG 上也存 SQLite 格式的 UTC 文本

实测第 3→4 轮证明:只要时间列在两个后端上**类型一致**,建表就能完成。选择「全部 `TEXT`,格式 `YYYY-MM-DD HH:MM:SS`,UTC」而不是「全部 `TIMESTAMPTZ`」:

- 仓里已有 `db-timestamp.ts` 和 `hub-timestamp-ratchet` 门围绕这个格式;API 返回的时间串在两个后端上**逐字相同**,app 不用改。
- 字符串比较(`created_at < datetime('now','-7 days')`)在两边语义一致。
- 代价:PG 上的时间索引是文本索引。对这个量级的 Hub 可以接受;以后要换 `TIMESTAMPTZ` 是单独一步。

翻译:`datetime('now')` → `to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,带偏移的形状同理。`db.ts` 里 PG 分支手写的 `NOW()`(终态事件触发器)一并改成这个表达式。

### 4.2 迁移方式

沿用现状:`db.ts` 在导入时执行幂等的 `CREATE … IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN`(吞「已存在」)+ 少量整表重建(SQLite 专用,PG 分支用 `ALTER COLUMN`)。**不引入迁移框架**,理由:SQLite 路径必须一字不变,而现有写法两个后端都能表达。

要补的只有一条规则:**新增的整表重建迁移必须同时写 PG 分支**。用一道静态门执行(§6.3)。

## 5. SQLite → PostgreSQL 数据迁移工具

`anet hub db migrate --from <sqlite 路径> --to <postgres URL>`(离线,Hub 必须停着):

1. **源只读**:以只读方式打开 SQLite;先 `VACUUM INTO` 一份快照再读,不碰原文件。
2. **目标建表**:用 Hub 自己的适配器对目标库跑一遍 schema(保证和运行时完全一致),不另写一份 DDL。
3. **目标必须为空**:任何业务表有行就拒绝(不做合并)。
4. **逐表拷贝**:按两边列名交集、分批 `INSERT`,整个过程一个 PG 事务;失败整体回滚。
5. **序列**:`BIGSERIAL` 列 `setval` 到 `MAX(id)`。
6. **校验**:每表行数 + 按主键排序后的内容哈希,两边一致才提交;打印每表对比。
7. 回滚方案:SQLite 原文件没动过,切回只需去掉 `DATABASE_URL`。

`docs-site/docs/deploy/hub-migration.md` 里「PG 不适用」那句,在工具发布后改为指向新页面。

## 6. CI 测试矩阵

### 6.1 目标

| 层 | SQLite | PostgreSQL |
|---|---|---|
| 翻译器单元测试(纯函数) | — | 每条规则 + 反例 |
| 适配器契约(`run/get/all/exec/transaction` 行为、回滚、类型归一) | 跑 | 跑(Docker) |
| Hub 冒烟:注册首个用户(断言 `admin`)→ 登录 → 节点令牌 → `report_status` → 派活 → SSE 收到 → 回复 → 任务 `replied` 且工具返回 ok | 已有(qa-hub-05 等) | 新套件 |
| 黑盒 L1(`qa-hub-*`)按 `DATABASE_URL` 参数化 | 已有 | 逐步打开 |

### 6.2 测试环境守卫怎么办

`assertSafeTestDatabaseEnv()` 规定「`NODE_ENV=test` 下继承的 `DATABASE_URL` 一律拒绝、没有旁路」,这条要保留。PG 套件因此**不走 `bun test` + `DATABASE_URL`**,而是:

- 套件在自己的 Docker compose 网络里起 `postgres` 服务,Hub 作为**普通进程**(非 `NODE_ENV=test`)启动,URL 在 `run.sh` 里构造、指向 compose 服务名;
- 适配器契约测试需要在 `bun test` 里连库时,另立一个**不同名**的变量(例如 `COMMHUB_TEST_PG_URL`),只接受指向本机或 compose 服务名、库名以 `_test` 结尾的 URL。**这是对守卫的扩展,需要 owner 单独批准**,在批准前只做第一种。

### 6.3 静态门

新增一道棘轮(与 `query-token-ratchet` 同形):`INSERT OR IGNORE/REPLACE`、`sqlite_master`、`PRAGMA`、`rowid` 只允许出现在 `dialect === "sqlite"` 分支或白名单文件里,存量豁免、只罚新增。

## 7. 不做的事

- 不把 PG 设为默认,不改 SQLite 任何行为。
- 不做多连接 / 读写分离 / 多 Hub 共享一个库(那需要把 SSE 在线表等内存状态外置,是另一个 RFC)。
- 不引入 ORM。

## 8. 小步发版计划

| 步 | 内容 | 对 SQLite 用户的影响 | 验收 |
|---|---|---|---|
| **S1** | Docker 套件 `test2123-hub-postgres-ladder`(#2125):容器内起 PostgreSQL + Hub,逐级爬 L0 连上 → L1 建表并监听 → L2 首个用户是 admin → L3 登录/节点令牌/派活 → L4 回复并终态;**棘轮**,低于 `FLOOR` 才红。注册进 `qa.yml` 的 Hub Docker 矩阵(不进 L1:L1 串行构建,本套件要装 postgresql)。不改生产代码 | 无 | 今天 `level=0`;以后每一步把 `FLOOR` 往上推 |
| **S2** | S2a(#2127):建表修复(切句、`BYTEA`、文本时间、int8)。S2b(#2129):换桥 —— Worker + `Bun.SQL` 保留连接,真事务、嵌套 savepoint;三处「拒绝」改为**默认仍关闭**,只有 `atomicTransactions` 为真**且** `COMMHUB_PG_EXPERIMENTAL=1` 时打开(见下) | 无(只动 PG 路径) | 契约测试 14 项、回滚见红;梯子在 opt-in 下到 L4 |
| **S3** | 翻译器:文本时间、`BIGINT`/`BIGSERIAL`/`BYTEA`、`strftime`;F1/F3/F4 逐处修 | 无(翻译只在 PG 路径执行;F3 改 `ORDER BY` 需在 SQLite 上回归) | Hub 在 PG 上建表完成;S1 套件推进到冒烟全绿(定时任务除外) |
| **S4** | 在 PG 上跑定时任务、运行证据、side-thread 的现有测试;都过了再**删掉 `COMMHUB_PG_EXPERIMENTAL`**,三处功能在 PG 上默认打开 | 无 | 冒烟套件不再需要 opt-in;`qa-hub-*` 选 3–5 个按 PG 参数化 |
| **S5** | `anet hub db migrate` + 文档(中英)+ 静态门 | 无 | 用一份造出来的 SQLite 库迁移,行数与哈希一致;文档页上线 |

**`COMMHUB_PG_EXPERIMENTAL`(S2b 引入,S4 删除)。** PG 适配器有了真事务之后,定时任务、任务运行证据、side-thread 命令外发这三项在 PG 上**仍默认拒绝**,因为它们在 PG 上还没有各自的测试。设 `COMMHUB_PG_EXPERIMENTAL=1` 才打开;不设时拒绝信息里写明这个变量和「experimental」。SQLite 不受影响。test2123 在这个 opt-in 下跑梯子并在结果行里打印它,同时单独验证「不设就拒绝」。这个变量只写在本 RFC 和 `server/README.md`,不进用户指南。

S1 完成后,troubleshooting 的「支持 PostgreSQL 吗?」一节可以加一句「当前状态见 CI 套件 X」;S4 之前**不改**「不建议生产使用」的口径。

## 9. 待定

1. 时间列存文本(§4.1)是否接受?(推荐:接受)
2. §6.2 为 `bun test` 连库新增变量,是否批准?(推荐:S2 时再定,S1 不需要)
3. 目标 PG 版本下限:建议 14+(`BIGSERIAL`、`to_char` 都不挑版本;下限只为 CI 固定一个版本)。
