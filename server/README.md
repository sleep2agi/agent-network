# @sleep2agi/commhub-server

[![npm version](https://img.shields.io/npm/v/@sleep2agi/commhub-server.svg)](https://www.npmjs.com/package/@sleep2agi/commhub-server)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/commhub-server.svg)](https://www.npmjs.com/package/@sleep2agi/commhub-server)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

CommHub: MCP Streamable HTTP + SSE push + REST API for an AI agent network. Single-process Bun server, SQLite-backed, zero config when launched through `anet`.

The supported path is to install the `anet` CLI (`@sleep2agi/agent-network`) and run `anet hub start`, which wires up the port, default admin account, recovery admin `utok_`, and local config for you.

## Quick start (verified)

> ⚠️ **Do not run `bunx @sleep2agi/commhub-server` without a version**
> Without a version this resolves to the npm `latest` dist-tag, and **`latest` is currently `0.8.8` (published 2026-06-24)**.
> 
> On `0.8.8` an anonymous `GET /health` **returns the `{networkId}:{alias}` of every live SSE connection** — no token required.
> The redaction fix is [`7bacb729`](https://github.com/sleep2agi/agent-network/commit/7bacb729) (`security(#473)`, **2026-07-29**),
> **35 days after** `0.8.8` shipped, so `0.8.8` does not contain it.
> 
> **Pin a version, or use the preview channel:**
> 
> ```bash
> bunx --bun @sleep2agi/commhub-server@preview      # contains the redaction fix
> ```
> 
> Or use the supported path, `anet hub start`, which pulls the version in `PINNED_SERVER_VERSION` rather than `latest`.
> 
> Self-check: `curl -sS http://<host>:9200/health | jq 'has("sse_sessions")'` — `true` means you are on an affected build.

```bash
# Recommended — through the anet CLI
npm install -g @sleep2agi/agent-network
anet hub start
#   • http://127.0.0.1:9200 by default
#   • SQLite at ~/.commhub/commhub.db
#   • Default admin account auto-created: admin / anethub
#   • Reset hint printed in the launch banner

# Or directly via bunx (Bun required). Direct runs need explicit auth or dev-open.
bunx @sleep2agi/commhub-server --dev-open

# With custom port / legacy master token (soft-deprecated; prefer user/ntok auth)
bunx @sleep2agi/commhub-server --port 9200 --token your-secret
```

Once running:

| Surface | URL |
|---|---|
| Health | `GET /health` |
| MCP (Streamable HTTP) | `POST /mcp` |
| SSE per-agent push | `GET /events/:alias` |
| REST | `/api/*` |

## Pairs with

| Package | |
|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | CLI |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | Web UI |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent runtime host |

Install the matching versions with `npm install -g <pkg>` — the `latest` dist-tag on npm is
authoritative. Pinning versions here goes stale on every release and nobody comes back to fix it.

## MCP tools

### Agent-side
| Tool | Description |
|---|---|
| `report_status` | Heartbeat + status (idle / working / blocked / error / offline) |
| `report_completion` | Final completion payload |
| `get_inbox` | Pull pending tasks |
| `ack_inbox` | Acknowledge receipt |

### Hub-side (used by Dashboard, Claude Code, peer agents)
| Tool | Description |
|---|---|
| `send_task` | Dispatch a task (supports `ttl_seconds`) |
| `send_message` | Send a chat message (no task lifecycle) |
| `send_reply` | Reply to a task (`replied` / `failed` / `cancelled`, plus `in_reply_to`) |
| `send_ack` | Acknowledge without inbox |
| `retry_task` | Retry failed / expired / cancelled tasks |
| `cancel_task` | Cancel a pending task |
| `reassign_task` | Move a task to a different agent |
| `get_task` | Fetch task details (used by peer-coordination polling) |
| `get_all_status` | Global presence panel |
| `get_session_status` | Per-session detail |
| `broadcast` | Group send |
| `list_tasks` | Task list, filterable by `network_id` |
| `get_completions` | Completion history |

> The table above lists the 17 **collaboration-core** tools. Node lifecycle / provider ops tools ship on the same MCP surface — the authoritative full list is [docs-site/docs/api/mcp-tools.md](../docs-site/docs/api/mcp-tools.md). Don't read the count above as "17 tools total".

## REST API

The server exposes ~33 endpoints across health, auth, networks, and observability surfaces. The endpoints in use today by the verified flow are:

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/health` | No auth |
| POST | `/mcp` | MCP entry |
| POST | `/api/auth/register` | Bootstrap admin |
| POST | `/api/auth/login` | Returns user token |
| GET | `/api/auth/me` | Current user |
| PUT | `/api/auth/me` | Edit profile |
| POST | `/api/auth/password` | Change password |
| GET / POST / DELETE | `/api/auth/tokens[…]` | Manage API tokens |
| GET | `/api/status` | Sessions snapshot |
| GET | `/api/tasks` | Task list (Dashboard) |
| GET | `/api/messages` | Message list (Dashboard) |
| GET | `/api/nodes` | Node directory |
| GET | `/api/stats` | Aggregate stats |
| GET | `/api/audit-log` | Audit trail |

Network-management endpoints (`/api/networks…`) are present and used by the current CLI. `/api/license[…]` is present as an experimental legacy trial/pro-license surface.

Auth: `Authorization: Bearer <token>` header, or `?token=<token>` query.

## SQLite schema

Auto-created on first run.

| Table | Purpose |
|---|---|
| `sessions` | Live agent sessions |
| `inbox` | Pending messages and tasks |
| `tasks` | Task state machine |
| `nodes` | Persistent node identity |
| `completions` | Final completion records |
| `task_events` | Per-state audit |
| `users` | Accounts |
| `networks` | Workspaces |
| `api_tokens` | `utok_` / `ntok_` / `atok_` tokens |
| `audit_log` | Operation audit |
| `licenses` | Experimental trial/pro-license state |
| `network_members` | Workspace membership |
| `network_invites` | Invite codes |

Task state machine:

```
created → delivered → acked → running → replied
                                      → failed → retry → delivered
                                      → cancelled
delivered → expired (5min watchdog)
delivered/acked/running → reassign → delivered (new agent)
```

## PostgreSQL (community extension point — not on the maintained roadmap)

> v0.8+ product direction is **SQLite only** (see [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md)). The PostgreSQL adapter interface is preserved as a community extension point — no E2E coverage on the current stable line; **not recommended for mainline production**.

Set `DATABASE_URL` to switch to PostgreSQL — the SQL layer auto-translates SQLite-isms (datetime, parameter placeholders) so application code is unchanged. Requires `bun add pg`.

```bash
DATABASE_URL=postgres://user:pass@host:5432/commhub bunx @sleep2agi/commhub-server
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `9200` | listen port |
| `HOST` | `0.0.0.0` in the server package, `127.0.0.1` when launched by `anet hub start` | listen address |
| `COMMHUB_AUTH_TOKEN` | (none) | Bearer token gate (legacy) |
| `COMMHUB_DB` | `~/.commhub/commhub.db` | SQLite path |
| `DATABASE_URL` | (none) | switches to PostgreSQL when set (unverified) |

## Running the unit tests

### 先说该走哪条路:Docker

仓库规约是测试在 Docker 里跑(`CLAUDE.md`「所有测试在 Docker 里跑:不碰本地
环境,不改生产」)。`server/src` 的测试在 `tests/` 下已经有 **24 个**按主题分片的
套件覆盖(实测:遍历 main 上 204 个套件目录,run.sh 里跑 `server/src/*.test.ts`
的有 24 个),每个都在容器内自带 `COMMHUB_DB`。跑其中任意一个都是这个形状:

```bash
# 从仓根跑
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -t anet-test624 -f tests/test624-task-cursor-pagination/Dockerfile .
docker run --rm anet-test624
```

（实跑过:退出码 0,`6 pass / 0 fail`,`RESULT: PASS`。换成 `tests/` 下别的
`test*-*/Dockerfile` 同理,但 **build-arg 的名字要照抄那个 Dockerfile** ——
main 上 66 处写的是 `SOURCE_COMMIT`,另有若干写成 `TEST<编号>_SOURCE_COMMIT`
(如 `TEST686_SOURCE_COMMIT`、`TEST765_SOURCE_COMMIT`)。传错名字不会报错,
只会让套件收到 `unknown` 然后按它自己的规则红或绿 —— 这不是你想要的那种绿。）

> ⚠️ **目前没有一个套件跑「`server/src` 下的全部」单测。** 上面那些是按主题
> 分片的;聚合门在 #798 里,尚未合入 main。所以「所有分片套件都绿」**不等于**
> 69 个单测文件都跑过 —— 在 #798 合入之前,不要把前者当成后者。

### 直接在宿主上跑时的两条契约

下面这两条是上面那些套件在容器内**已经替你满足**的东西。你只有在本地迭代
单个文件时才需要自己处理它们 —— 而那种跑法不构成任何门禁证据。


1. **`COMMHUB_DB` must be set.** It is not optional — `~/.commhub/commhub.db` is a
   *live* database on any machine that has ever run a hub. This one is enforced:
   with `NODE_ENV=test` (which `bun test` sets) and no `COMMHUB_DB`, the adapter
   refuses with `REFUSING to open the default SQLite database`.

2. **Each test *file* needs its own database.** This is *not* enforced — a single
   shared `COMMHUB_DB` passes the guard above and then fails a handful of tests
   for reasons that look like product bugs but are not. `scripts/qa.sh` encodes
   the real contract:

   ```bash
   # 从仓根跑(见下),每个文件一个全新的库
   f=server/src/auth-validate.test.ts
   db=/tmp/anet-$(basename "$f" .test.ts).db
   rm -f "$db"                       # 复用上一次的库同样会破坏隔离
   COMMHUB_DB="$db" bun test "$f"
   ```

   整套跑法:

   ```bash
   rc=0
   # 用 find 而不是 `server/src/*.test.ts` —— glob 不进子目录,会漏掉
   # server/src/shared/ 下的 3 个(实测:深度 1 是 66 个,递归是 69 个)。
   # scripts/qa.sh 与 test798 用的就是 find,这里保持一致。
   while IFS= read -r f; do
     # 用完整路径派生库名,不用 basename:加入子目录之后,
     # 两个不同目录下的同名文件会派生出同一个库(原来只扫单层时不可能)。
     db=/tmp/anet-$(printf '%s' "${f%.test.ts}" | tr '/.' '--').db
     rm -f "$db" "$db-wal" "$db-shm"
     COMMHUB_DB="$db" bun test "$f" || { echo "FAILED: $f"; rc=1; }
   done < <(find server/src -type f -name '*.test.ts' | sort)
   [ "$rc" -eq 0 ]
   ```

   ⚠️ 最后那行 `[ "$rc" -eq 0 ]` 不是装饰,是这段的**门**。写成
   `bun test "$f" || echo "FAILED: $f"` 会让循环打印一行然后继续,
   整段的退出码恒为 0 —— **测试全红,脚本报绿**。用 `[ ... ]` 而不是
   `exit "$rc"`,是为了这段直接粘进终端时不会把你的 shell 关掉;
   存成脚本跑时,它是最后一条命令,脚本退出码就等于它。

   ⚠️ 别把 `$name` 之类的占位符原样抄进命令行 —— 未定义的变量会展开成空串,
   于是每个文件都写进**同一个** `/tmp/…-.db`,正好是这一节要避免的事。

   Symptom if you ignore it: `bun test src/` under one database turns
   `admin-networks-http` and `scheduled-tasks-http` red. Both are **global-count
   assertions that are correct under the contract**:

   ```ts
   // admin-networks-http.test.ts — the admin sees EXACTLY this file's two networks
   expect(new Set(rows.map((row) => row.network_id)))
     .toEqual(new Set([adminNetworkId, memberNetworkId]));

   // scheduled-tasks-http.test.ts — EXACTLY one due occurrence was processed
   expect(runDueScheduledTasks().processed).toBe(1);
   ```

   Share a database and other files' networks and due schedules join the count.
   Nothing is broken; the run violated the contract.

   `scripts/qa.sh` 的 L0 目前只点名跑 5 个 server 测试(白名单),不是全量;
   把 `server/src` 全域逐文件跑起来的那道 CI 门还在评审中(`#798`),
   未进 `main` —— 所以本节描述的是**契约**,不是「已经有东西在替你执行它」。

## Auth modes

1. **V3 user system (default)** — `POST /api/auth/register` and `/api/auth/login` issue `utok_…` tokens; nodes get `ntok_…`.
2. **Legacy global token** — set `COMMHUB_AUTH_TOKEN` and pass it as Bearer / query.

`/health` is always public.

## Not verified

- `/api/license*` — experimental legacy trial/pro-license endpoints.
- PostgreSQL backend — translation layer exists, no E2E run.
- Telegram / WeChat / Feishu channel endpoints — channel code exists, but only Telegram-oriented agent-node paths are actively exercised.

## License

Apache-2.0
