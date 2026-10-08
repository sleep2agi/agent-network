#!/usr/bin/env bash
# test2123-hub-postgres-ladder — how far does the Hub get on a real PostgreSQL?
#
# RFC-039 S1. The Hub has a DATABASE_URL=postgres:// entry but no CI job had
# ever pointed it at a real server. This suite does, and reports the highest
# rung reached:
#
#   L0  adapter connects to PG ("PostgreSQL connection verified")   ← always required
#   L1  schema built: every module-level CREATE/ALTER ran and startHub() was
#       reached — the hub is listening, or startHub() refused with the
#       scheduled-task backend error (which it raises before binding a port)
#   L2  hub listening (/health 200)
#   L3  first registered user is admin
#   L4  login → node token → report_status → POST /api/task
#   L5  send_reply ok and the task row is replied
#   L6  task board slim reads: view=summary, changes=1 + delete tombstone, ETag 304
#
# Before the ladder, contract.ts checks PgAdapter itself on the same server
# (rollback, savepoints, caught errors inside a transaction, int8/BLOB/bool
# types). That part is pass/fail, not a ratchet.
#
# It is a ratchet, not a pass/fail smoke: the suite is red only when the level
# drops below FLOOR. Each RFC-039 step that moves the Hub up a rung raises
# FLOOR in the same PR. Reaching above FLOOR prints a note, never red.
#
# Everything is inside this container: Postgres on 127.0.0.1, a throwaway
# HOME, a non-default port. NODE_ENV is not "test", so the adapter's
# test-env DATABASE_URL guard is not involved (it refuses inherited URLs
# under `bun test`; this is an ordinary hub process with a URL built here).
set -euo pipefail
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"
# CI passes the commit it built; an image built from something else must not
# report a level on this commit's behalf.
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "$EXPECTED_SOURCE_COMMIT" != "${SOURCE_COMMIT:-}" ]; then
  echo "FAIL: source provenance mismatch image=${SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"
  exit 1
fi

# Current floor: with COMMHUB_PG_EXPERIMENTAL=1 the Hub completes the whole
# ladder on PG — schema, listen, admin bootstrap, task, atomic reply
# (RFC-039 S2b real transactions + S3 typed NULL-checked parameters).
# L6 (2026-09-30): the task board's slim reads — view=summary, changes=1 with delete tombstones, ETag 304.
FLOOR="${PG_LADDER_FLOOR:-6}"
SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_PORT=25433
HUB_PORT=29213
HUB_WAIT_SECS="${HUB_WAIT_SECS:-300}"

WORK="$(mktemp -d /tmp/test2123.XXXXXX)"
chmod 0755 "$WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
PGDATA="$WORK/pgdata"; PGSOCK="$WORK/pgsock"
mkdir -p "$PGDATA" "$PGSOCK"; chown postgres:postgres "$PGDATA" "$PGSOCK"

HUB_PID=""
cleanup() {
  [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null || true
  if [ -n "${ARTIFACT_DIR:-}" ]; then
    mkdir -p "$ARTIFACT_DIR"
    cp "$WORK/hub.log" "$ARTIFACT_DIR/test2123-hub.log" 2>/dev/null || true
    cp "$WORK/hub-noflag.log" "$ARTIFACT_DIR/test2123-hub-noflag.log" 2>/dev/null || true
    cp "$PGSOCK/pg.log" "$ARTIFACT_DIR/test2123-pg.log" 2>/dev/null || true
  fi
  runuser -u postgres -- "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -n 1)"
echo "[pg] $("$PG_BIN/postgres" --version)"
# TCP connections need a password (scram); only the admin socket is trusted.
# The Hub and the tests connect as ordinary roles over TCP — no password-less
# superuser anywhere in what the product sees.
runuser -u postgres -- "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGSOCK/pg.log" -w \
  -o "-p $PG_PORT -k $PGSOCK -c listen_addresses=127.0.0.1" start >/dev/null
psql_admin() { runuser -u postgres -- "$PG_BIN/psql" -h "$PGSOCK" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
LADDER_PW="ladder-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
TEST_PW="tester-$(od -An -tx8 -N8 /dev/urandom | tr -d ' ')"
psql_admin -d postgres -c "CREATE ROLE anet_ladder LOGIN PASSWORD '$LADDER_PW'" \
  -c "CREATE ROLE anet_tester LOGIN PASSWORD '$TEST_PW'"
for db in commhub commhub_noflag; do psql_admin -d postgres -c "CREATE DATABASE $db OWNER anet_ladder"; done
# Adding a PG test = add ONE `run_pg_tests_rc <db> <file>` line below; its database is derived from those lines here (no shared list to edit).
PG_TEST_DBS="$(grep -oE '^run_pg_tests_rc [a-z0-9_]+' "${BASH_SOURCE[0]}" | awk '{print $2}' | sort -u)"
[ -n "$PG_TEST_DBS" ] || { echo "FAIL harness: no run_pg_tests_rc databases found in ${BASH_SOURCE[0]}"; exit 1; }
for db in $PG_TEST_DBS; do psql_admin -d postgres -c "CREATE DATABASE $db OWNER anet_tester"; done
LADDER_URL_BASE="postgres://anet_ladder:$LADDER_PW@127.0.0.1:$PG_PORT"

# Positive control for the harness itself: the database we are about to hand
# the Hub answers a query. Without this a dead Postgres would read as "Hub
# can't reach L0" — a harness failure dressed up as a product finding.
PGPASSWORD="$LADDER_PW" runuser -u postgres --preserve-environment -- "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U anet_ladder -d commhub -Atc 'select 1' | grep -qx 1
echo "[pg] ready on 127.0.0.1:$PG_PORT"

# PgAdapter contract (RFC-039 S2b): real transactions, savepoints, types.
# Not a ratchet — any failure here is red regardless of FLOOR.
contract_rc=0
(cd /work/server && env -u NODE_ENV -u COMMHUB_DB \
  bun "$SUITE_DIR/contract.ts" "$LADDER_URL_BASE/commhub" /work/server/src/db-adapter.ts) || contract_rc=$?

# Default-closed gate (RFC-039): without COMMHUB_PG_EXPERIMENTAL=1 a PG Hub
# must refuse to start its scheduler, and say which variable opens it. Own
# database so the ladder below starts from an empty one. Pass/fail, not ratcheted.
gate_rc=0
cd /work/server
set +e
env -u NODE_ENV -u COMMHUB_DB -u COMMHUB_PG_EXPERIMENTAL \
  DATABASE_URL="$LADDER_URL_BASE/commhub_noflag" \
  PORT="$HUB_PORT" HOST=127.0.0.1 \
  timeout 120 bun src/index.ts >"$WORK/hub-noflag.log" 2>&1
noflag_rc=$?
set -e
if [ "$noflag_rc" -eq 124 ]; then
  echo "FAIL gate: without the opt-in the PG Hub kept running (gate open by default)"; gate_rc=1
elif grep -q 'scheduled_tasks_require_transactional_sqlite_backend.*COMMHUB_PG_EXPERIMENTAL=1' "$WORK/hub-noflag.log"; then
  echo "PASS gate: without the opt-in the PG Hub refuses and names COMMHUB_PG_EXPERIMENTAL=1"
elif ! grep -q 'scheduled_tasks_require_transactional_sqlite_backend' "$WORK/hub-noflag.log"; then
  # Never reached startHub() (schema broke first): the ladder reports that.
  echo "SKIP gate: the Hub did not reach startHub() without the opt-in (exit=$noflag_rc)"
else
  echo "FAIL gate: refusal does not name COMMHUB_PG_EXPERIMENTAL=1"; grep -m1 scheduled_tasks "$WORK/hub-noflag.log" || true; gate_rc=1
fi

# The ladder runs under the experimental opt-in; the result line says so.
PG_EXPERIMENTAL=1
env -u NODE_ENV -u COMMHUB_DB \
  COMMHUB_PG_EXPERIMENTAL="$PG_EXPERIMENTAL" \
  DATABASE_URL="$LADDER_URL_BASE/commhub" \
  PORT="$HUB_PORT" HOST=127.0.0.1 \
  bun src/index.ts >"$WORK/hub.log" 2>&1 &
HUB_PID=$!

health() {
  bun -e "fetch('http://127.0.0.1:$HUB_PORT/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1
}

LEVEL=-1
FIRST_FAIL=""
up=0
t0=$SECONDS
for _ in $(seq 1 "$HUB_WAIT_SECS"); do
  if health; then up=1; break; fi
  kill -0 "$HUB_PID" 2>/dev/null || break
  sleep 1
done

if grep -q 'PostgreSQL connection verified' "$WORK/hub.log"; then LEVEL=0; fi
if [ "$LEVEL" = 0 ] && { [ "$up" = 1 ] || grep -q 'scheduled_tasks_require_transactional_sqlite_backend' "$WORK/hub.log"; }; then
  LEVEL=1
fi

if [ "$up" = 1 ]; then
  LEVEL=2
  ladder_out="$(bun "$SUITE_DIR/ladder.ts" "http://127.0.0.1:$HUB_PORT" 2>&1 || true)"
  printf '%s\n' "$ladder_out"
  reached="$(printf '%s\n' "$ladder_out" | sed -n 's/^LADDER_LEVEL=//p')"
  [ -n "$reached" ] && LEVEL="$reached"
  FIRST_FAIL="$(printf '%s\n' "$ladder_out" | grep -m1 '^FAIL ' || true)"
else
  hub_rc="running"
  kill -0 "$HUB_PID" 2>/dev/null || { wait "$HUB_PID" 2>/dev/null && hub_rc=0 || hub_rc=$?; }
  # The first line bun prints for an uncaught error is "error: <message>".
  err="$(grep -m1 -E '^(error|Error)[: ]' "$WORK/hub.log" || true)"
  FIRST_FAIL="FAIL L$((LEVEL + 1)) hub not listening after $((SECONDS - t0))s (hub exit=$hub_rc): ${err:-see hub.log}"
  echo "$FIRST_FAIL"
fi

# RFC-039 S4: the existing scheduler, side-thread outbox and runtime-evidence
# (task-consumption) test files, plus agent-acl-slice3 (human DMs, node
# lookups by alias — RFC-039 F3/F5) and skillhub (LIKE case — F6), run
# unmodified on PostgreSQL through the test-only COMMHUB_TEST_PG_URL (loopback,
# anet_*_test database, password role) with the experimental opt-in.
# Pass/fail, not ratcheted.
features_rc=0
# `| tail` would hide bun's exit code; collect it explicitly instead.
run_pg_tests_rc() {
  local db=$1 file=$2 out rc=0
  out="$(cd /work/server && env -u DATABASE_URL -u COMMHUB_DB \
    COMMHUB_TEST_PG_URL="postgres://anet_tester:$TEST_PW@127.0.0.1:$PG_PORT/$db" \
    COMMHUB_PG_EXPERIMENTAL=1 \
    bun test "$file" 2>&1)" || rc=$?
  printf '%s\n' "$out" | grep -E '^\((pass|fail)\)|^ *[0-9]+ (pass|fail)$|^error:' || true
  echo "[features] $file rc=$rc"
  [ "$rc" -eq 0 ] || features_rc=1
}
run_pg_tests_rc anet_sched_test src/scheduled-tasks-http.test.ts
run_pg_tests_rc anet_node_adoption_test src/node-daemon-bindings.test.ts
run_pg_tests_rc anet_side_thread_test src/side-thread-command-transport.test.ts
run_pg_tests_rc anet_evidence_test src/task-consumption.test.ts
run_pg_tests_rc anet_acl_dm_test src/agent-acl-slice3-http.test.ts
# #563: a granted member sees the whole timeline of a node they can see (addAgentTimelineScope — NOT IN subqueries
# and reused ?N placeholders) — on real PostgreSQL rows.
run_pg_tests_rc anet_acl_timeline_test src/agent-acl-http.test.ts
run_pg_tests_rc anet_skillhub_test src/skillhub-http.test.ts
# RFC-038 §9: task visibility is a LIKE … ESCAPE clause on JSON text columns — run it on real PostgreSQL rows,
# including member ids that contain % and _ (task-access-http.test.ts「LIKE 通配符不越权」).
run_pg_tests_rc anet_task_access_test src/task-access-http.test.ts
# Task dashboard: completed_at set / cleared on POST / PATCH (typed NULL parameters on PostgreSQL) and
# GET /api/requirements/stats under the same task-visibility clause, on real PostgreSQL rows.
run_pg_tests_rc anet_req_stats_test src/requirements-stats-http.test.ts
# 标签管理:改写整网卡片 tags 的事务、network_tags 的 ON CONFLICT upsert、scoped 成员被挡 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_tag_ops_test src/requirement-tag-ops-http.test.ts
# #711 改密码只撤 kind='login' 会话、cli 令牌按旗标撤、节点令牌不动;kind 列 ALTER + 回填(DROP COLUMN 回到旧表再迁一遍)—— 在真 PostgreSQL 上。
run_pg_tests_rc anet_pwchange_kind_test src/auth-password-change-cli-tokens-http.test.ts
# Scheduled-task replies routed to the schedule creator (scheduled_tasks ⋈ users, tasks.meta_json read in JS),
# counted by unread_by_agent and cleared by ack-by-agent — on real PostgreSQL rows.
run_pg_tests_rc anet_sched_reply_test src/scheduled-reply-unread-http.test.ts
# 任务看板省流:view=summary、changes=1 的墓碑(ON CONFLICT upsert + NOT IN 子查询)、列表缓存作废 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_slim_test src/requirements-list-slim-http.test.ts
# 任务动态(#429):写路径与流水同一事务(PG 上真回滚)、BIGSERIAL id 翻页、按可见性过滤 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_events_test src/requirement-events-http.test.ts
# 可选人列表:display_name 单独返回(COALESCE 空串),name 回落不变 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_people_test src/requirements-people-http.test.ts
# /api/status?node_id=:按节点过滤与网络范围叠加(不越权、未知 id 空列表、light 带 node_id)—— 在真 PostgreSQL 上。
run_pg_tests_rc anet_status_node_test src/status-node-id-filter-http.test.ts
# #431 /api/status 记忆化 + ETag:缓存正文 == 当场重算(随机写序列)、写钩子挂在 PG 适配器上、无指向 sessions 的外键/触发器。
run_pg_tests_rc anet_status_cache_test src/status-read-cache-http.test.ts
# #470 MCP 写入 owner 只收人(owner_must_be_human + hint)、响应 == 落库、REST 旧 App 兼容不变 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_owner_strict_test src/requirements-owner-strict-mcp-http.test.ts
# #472 任务 / 项目错误带 field / message / hint(error 码原样),每条提示一个测试 + 错误码登记取集门。
run_pg_tests_rc anet_req_errors_test src/requirements-errors-mcp-http.test.ts
# 任务状态「废弃」:CHECK 约束换新(PG 换默认名约束)、关闭态不逾期 / 不提醒 / 不计开着、旧客户端投影成 done —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_abandoned_test src/requirements-abandoned-http.test.ts
# #474 评论:只追加、进动态 kind=comment、看不见 404 / 只读 403、不改任务本身 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_comment_test src/requirements-comment-http.test.ts
# #506 列表每行 last_event:MAX(id) GROUP BY 子查询 + IN 绑参(每个都用上)、评论算最新、节点操作者、ETag 随评论变、受限成员隐去;
# #506 跟进:changes=1 的 updated_since 同一个占位符用两次(updated_at OR requirement_events.created_at 子查询)—— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_last_event_test src/requirements-last-event-http.test.ts
run_pg_tests_rc anet_tool_audience_test src/tool-audience-http.test.ts
run_pg_tests_rc anet_dept_heads_test src/department-heads-http.test.ts
run_pg_tests_rc anet_req_status_part_test src/requirements-status-participants-http.test.ts
# 参与人改状态 / 检查项 + 通知私信(user_inbox 插入、未读时 UPDATE 改写、可见性子句不变)—— 在真 PostgreSQL 上。
run_pg_tests_rc anet_part_notify_test src/requirement-participant-notify-http.test.ts
# MCP projects_create / projects_update / requirements_events(app 任务页审计 M3):走 app 同一套 REST 处理,逐类调用者对照 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_mcp_proj_events_test src/mcp-projects-events-http.test.ts
# 组织架构(board #419):network_departments 新表 + network_members.department_id(ALTER)、IS NULL 分支的同级查重 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_departments_test src/departments-http.test.ts
# Agent 归部门(#751):network_node_departments 新表、JOIN nodes / network_departments、删部门清节点归属 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_node_depts_test src/node-departments-http.test.ts
# 项目列表的 viewer_can.edit(app 任务页审计 L13):一次读授权表 + 每个项目真建卡比对 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_proj_viewer_can_test src/project-viewer-can-http.test.ts
# 降级节点拒收新任务(#460):REST /api/task 409、MCP send_task / retry / reassign、定时任务 run 记 node_degraded —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_health_dispatch_test src/node-health-dispatch-http.test.ts
# 同一节点两份副本(#507):节点 SSE 只留最新一条、任务只投一份、副本停机不把另一份标离线(会话行 UPDATE + audit_log)—— 在真 PostgreSQL 上。
run_pg_tests_rc anet_node_conflict_test src/node-identity-conflict-http.test.ts
# 换 resume_id 时粘性能力位接手(#550):handover 的 DELETE+INSERT 之后,固定一条 UPDATE(CASE WHEN ?N = 1,每个参数都用上)把旧行为 1 的四个能力位带过去 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_handover_caps_test src/report-status-handover-capabilities-http.test.ts
# MCP requirements_list 省流(#471):summary + 50 默认、严格参数、tag= 精确筛 + 游标翻页、REST 默认不变 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_list_mcp_test src/requirements-list-mcp-slim-http.test.ts
# MCP requirements_people + 人员字段按名字写(#473):成员 ⋈ 部门 ⋈ 节点主人、只在任务所在网络里解析、受限成员看不见的 Agent —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_req_people_mcp_test src/requirements-people-mcp-http.test.ts
# MCP 上下文成本(#476):全网动态默认 50 + 游标、单卡与 REST 默认不变、tools/list 字节上限 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_ctx_cost_test src/mcp-context-cost-http.test.ts
# 节点登录失效通知主人(#462):api_tokens ⋈ nodes 取主人、user_inbox 插入与「未读同类」查重 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_model_auth_notify_test src/model-auth-notify-http.test.ts
# 定时任务卡住(#464):按挡路任务计数跳过、超时把它条件写成 expired 并镜像 run、通知创建者 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_sched_stuck_test src/scheduled-stuck-http.test.ts
# 定时任务连续失败(#523):「最近一次成功之后的 failed 数」(TEXT 比较 scheduled_for)、去重条件写(COALESCE(key, '') <> ?2 / ISO 时间比较)、
# 自动暂停条件写、/runs 的 LEFT JOIN tasks + CASE/SUBSTR 取失败原因 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_sched_failing_test src/scheduled-failures-http.test.ts
# Agent 管定时任务(#733):新列 created_by_node_id(ALTER 加列 + 索引)、按网络 ∧ (目标 ∨ 创建节点) 取集、每节点配额 COUNT、派发时复查创建节点 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_agent_sched_test src/schedule-agent-mcp-http.test.ts
# 任务过期通知发送方(#500):巡检的 consumed_at < expires_at 判据(TEXT 时间戳比较)、按分支绑参的「前面还有几个」计数、inbox reply 行 + user_inbox 通知、父任务不被改终态 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_expiry_notice_test src/task-expiry-notice-http.test.ts
# 长时间无动静的已开工任务(#519):acked / running 的「每列都早于截止点 + NOT EXISTS 更晚的 task_events」判据(TEXT 时间戳 + datetime 偏移翻译)、
# ORDER BY … LIMIT 500 + 每行带同样条件的守卫 UPDATE、COALESCE(result, ?) 写原因、task.stale_expired 事件;以及过期通知「前面还有几个」的 24 小时下界 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_stale_open_test src/task-stale-open-http.test.ts
# 孤儿任务(#758):acked / running 的任务 JOIN sessions(COALESCE(network_id, 'default'))、idle / offline 且 COALESCE(last_seen_at, updated_at) 晚于开工时刻(TEXT 时间戳比较)、
# datetime 偏移截止点、ON CONFLICT(task_id, event_key) DO NOTHING 的 changes 只通知一次、inbox reply / user_inbox 通知、scheduler 不通知 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_orphan_test src/task-orphan-http.test.ts
# 派活时的队列信息(#500 第二步):开着任务 COUNT + SUM(CASE) 按分支绑参、24 小时窗口(datetime 偏移翻译)、耗时样本 ORDER BY … LIMIT、
# /api/status 全量 queue_depth 的 GROUP BY network_id, to_name、写 tasks 让全量缓存失效 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_queue_ahead_test src/task-queue-ahead-http.test.ts
# 网络令牌按成员身份(#488):resolveToken 的 EXISTS(network_members) 判据、移出成员同事务吊销令牌、401 reason —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_token_member_test src/network-token-membership-http.test.ts
# 节点自己的权限(RFC-041 第一阶段,#487):permission_mode 列、node_permission_log 按小时合并的 upsert、受限节点的 LIKE … ESCAPE 子查询、报表聚合 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_node_perm_test src/node-permissions-http.test.ts
# 部门群(RFC-042 第一个 PR,#457):chat_groups 的 (network_id, department_id) 唯一索引允许多个 NULL、ON CONFLICT DO NOTHING 播种成员、删部门同事务解除关联 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_dept_groups_test src/department-groups-http.test.ts
# 部门群成员同步(RFC-042 第二个 PR,#457):调人 / 改上级 / 换负责人 / 删部门 / 移出网络 同事务对账(嵌套事务 = savepoint)、按分支绑参的查询、手动成员 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_dept_groups_sync_test src/department-groups-sync-http.test.ts
# 部门群消息(RFC-042 第三个 PR,#457):BIGSERIAL seq 游标翻页、client_request_id 去重(ON CONFLICT DO NOTHING 的 changes)、已读位置 upsert 只前进(excluded + CASE)、未读子查询(LEFT JOIN + COALESCE)、群附件可见性(JOIN + LIKE … ESCAPE)—— 在真 PostgreSQL 上。
run_pg_tests_rc anet_group_msgs_test src/group-messages-http.test.ts
# 入群 / 退群事件(RFC-042 §9.3 补口,#457):提交后才推 group_membership_changed —— PG 上嵌套事务是 savepoint,内层回滚只丢内层那几笔、外层回滚一条不推。
run_pg_tests_rc anet_group_member_ev_test src/group-membership-events-http.test.ts
# 任务到期提醒 + 到期筛选(#491/#492/#494):requirement_due_reminders 复合主键 + ON CONFLICT DO NOTHING 的 changes 去重、due_on 范围扫描、length(due_on) 分支的 overdue / due_within_days 条件 —— 在真 PostgreSQL 上。
run_pg_tests_rc anet_due_reminders_test src/requirement-due-reminders-http.test.ts

# RFC-039 S5: `commhub-server migrate-to-pg` end to end (seed on SQLite,
# refusals, dry run, tamper → rollback, real copy, Hub on the copy to L5).
# Pass/fail, not ratcheted.
migrate_rc=0
PG_BIN="$PG_BIN" PGSOCK="$PGSOCK" PG_PORT="$PG_PORT" WORK="$WORK" SUITE_DIR="$SUITE_DIR" LADDER_PW="$LADDER_PW" \
  bash "$SUITE_DIR/migrate-stage.sh" || migrate_rc=$?

echo "--- hub.log (tail) ---"
tail -n 25 "$WORK/hub.log" || true
echo "----------------------"

echo "PG_LADDER level=$LEVEL floor=$FLOOR COMMHUB_PG_EXPERIMENTAL=$PG_EXPERIMENTAL first_fail=${FIRST_FAIL:-none}"
echo "NOTE: rungs L2+ were reached with COMMHUB_PG_EXPERIMENTAL=$PG_EXPERIMENTAL (experimental PG features on)."

if [ "$gate_rc" -ne 0 ]; then
  echo "RESULT: FAIL — PostgreSQL feature gate is not closed by default."
  exit 1
fi
if [ "$migrate_rc" -ne 0 ]; then
  echo "RESULT: FAIL — migrate-to-pg stage failed."
  exit 1
fi
if [ "$features_rc" -ne 0 ]; then
  echo "RESULT: FAIL — gated-feature tests failed on PostgreSQL."
  exit 1
fi
if [ "$contract_rc" -ne 0 ]; then
  echo "RESULT: FAIL — PgAdapter contract failed (rc=$contract_rc)."
  exit 1
fi
if [ "$LEVEL" -lt 0 ]; then
  echo "RESULT: FAIL — the Hub never reported a PostgreSQL connection (L0). Harness or adapter selection is broken."
  exit 1
fi
if [ "$LEVEL" -lt "$FLOOR" ]; then
  echo "RESULT: FAIL — regressed below the floor (level $LEVEL < floor $FLOOR)."
  exit 1
fi
if [ "$LEVEL" -gt "$FLOOR" ]; then
  echo "NOTE: level $LEVEL is above the floor $FLOOR — raise FLOOR in run.sh in this PR."
fi
echo "RESULT: PASS (level $LEVEL, floor $FLOOR)"
