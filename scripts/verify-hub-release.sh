#!/usr/bin/env bash
# Verify a published @sleep2agi/commhub-server release by its **real npm artifact**,
# not by CI's wording.
#
# Why this exists: the release gates in `.github/workflows/release.yml` check the
# *shape* of the release notes and install-path smoke, not whether the bytes users
# download actually contain the feature the notes promise. On 2026-10-23 two
# releases went out and the only thing that proved the features were in the
# tarball was an ad-hoc script in /tmp. This is that script, made repeatable.
#
# Usage:
#   scripts/verify-hub-release.sh                      # newest preview, feature probe per version
#   scripts/verify-hub-release.sh 0.9.0-preview.146
#   scripts/verify-hub-release.sh 0.9.0-preview.146 --tag latest
#
# Exit: 0 = the artifact really contains what the version promises; 1 = it does not.
# Read-only: downloads to a temp dir, never touches a running hub or a database.
set -uo pipefail

PKG="@sleep2agi/commhub-server"
VERSION="${1:-}"
CHANNEL="${3:-preview}"
if [ "${2:-}" = "--tag" ]; then CHANNEL="${3:-preview}"; fi

fail() { echo "FAIL: $*"; exit 1; }

command -v curl >/dev/null || fail "curl is required"
command -v python3 >/dev/null || fail "python3 is required"
command -v tar >/dev/null || fail "tar is required"

registry="https://registry.npmjs.org/${PKG}"

echo "== dist-tags"
tags=$(curl -sS --max-time 25 "$registry") || fail "cannot read the registry"
if [ -z "$VERSION" ]; then
  VERSION=$(printf '%s' "$tags" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("dist-tags",{}).get("preview",""))')
  [ -n "$VERSION" ] || fail "registry has no preview dist-tag"
  echo "   (no version given — using the preview dist-tag: $VERSION)"
fi
actual=$(printf '%s' "$tags" | python3 -c "import sys,json;print(json.load(sys.stdin).get('dist-tags',{}).get('$CHANNEL',''))")
[ "$actual" = "$VERSION" ] || fail "dist-tags.$CHANNEL is '$actual', not '$VERSION'"
echo "OK   dist-tags.$CHANNEL == $VERSION"

echo "== tarball"
work=$(mktemp -d "${TMPDIR:-/tmp}/verify-hub-release-XXXXXX") || fail "mktemp failed"
trap 'rm -rf "$work"' EXIT
tarball=$(curl -sS --max-time 25 "$registry/$VERSION" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("dist",{}).get("tarball",""))')
[ -n "$tarball" ] || fail "no tarball url for $VERSION"
curl -sSL --max-time 180 "$tarball" -o "$work/pkg.tgz" || fail "tarball download failed: $tarball"
echo "OK   downloaded $(wc -c <"$work/pkg.tgz") bytes"
tar -xzf "$work/pkg.tgz" -C "$work" || fail "tarball is not a readable .tgz"
[ -d "$work/package" ] || fail "tarball has no package/ directory"

pkgver=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$work/package/package.json")
[ "$pkgver" = "$VERSION" ] || fail "package.json inside the tarball says $pkgver, not $VERSION"
echo "OK   package.json version == $VERSION"

# ── feature probes, per version ───────────────────────────────────────────────
# 🔴 Guard the *behaviour claim*, not a file location. On 2026-10-23 a probe
# asserted `assign_agent` lived in departments.ts while it is dispatched from
# tools.ts — the release was fine, the probe was wrong. Grep the whole src tree.
has() { grep -rq -- "$2" "$work/package/src" 2>/dev/null; }
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }

check_feature() { # name, pattern, since-version
  if ver_ge "$VERSION" "$3"; then
    has src "$2" || fail "$1 missing from $VERSION (expected since $3)"
    echo "OK   $1"
  else
    echo "skip $1 (introduced in $3)"
  fi
}

check_feature "account avatar upload endpoint"  "avatar/upload"            "0.9.0-preview.145"
check_feature "strict PNG validation"           "interlaced_unsupported"   "0.9.0-preview.145"
check_feature "node session control relay"      "node-session-control"     "0.9.0-preview.145"
check_feature "departments MCP tool"            '"departments"'            "0.9.0-preview.146"
check_feature "departments assign_agent action" '"assign_agent"'           "0.9.0-preview.146"
# .148 标签创建与父子层级:能力位、写接口、树表、读面的 nodes 一起断言 ——
# 少任何一样,客户端按 tag_tree 显示「新建子标签」就会调到一个不存在的路由。
check_feature "tag tree capability"             '"tag_tree"'               "0.9.0-preview.148"
check_feature "tag create endpoint"             "requirements/tags/create" "0.9.0-preview.148"
check_feature "tag node table"                  "network_tag_nodes"        "0.9.0-preview.148"
check_feature "tag tree in the tags response"    "nodes"                    "0.9.0-preview.148"
# .152 网络规则（#993 首片）：表、读写路由、CAS 冲突码一起断言 ——
# 只断言"字符串出现过"不够：.151 上线后我用真请求才发现节点令牌能读别人的网络，
# 所以这里同时断言 CAS 的冲突码（语义的可见证据），而不只是路由名。
check_feature "network rules table"              "network_rules"            "0.9.0-preview.152"
check_feature "network rules route"              "networks"                 "0.9.0-preview.152"
check_feature "network rules CAS conflict code"  "rules_revision_conflict"  "0.9.0-preview.152"
check_feature "network rules node-token scope"   "user_token_required"      "0.9.0-preview.152"

# .158 节点自报 OpenCode 模型清单 + loopback 端点（#2293）。客户端「模型可选列表」
# 和「Runtime · V2 / OpenCode Server」两行读的就是这三格；断言的是**投影出的字段名**
# （/api/nodes 上真的出现），不是某个实现文件里的字符串。
check_feature "opencode catalog projection"  "opencode_catalog"    "0.9.0-preview.158"
check_feature "opencode server projection"   "opencode_server"     "0.9.0-preview.158"
check_feature "opencode generation scalar"   "opencode_generation" "0.9.0-preview.158"

# .159 SSE 背压收敛（#2363）：慢订阅者不再把队列堆到 1 MB/连接，广播也只编码一次。
# 断言的是**可运维的开关名**——发布说明与灰度都靠它。
check_feature "sse coalesce tunable"          "ANET_SSE_COALESCE_AT_BYTES"  "0.9.0-preview.159"
check_feature "sse degraded drop counter"     "sseDegradedDropCount"        "0.9.0-preview.159"

# .160 —— MCP 在飞可观测（#2363）：/health 直接给出“此刻有多少请求在飞 + 历史高水位”。
# RSS 与在飞数成正比（隔离实测 ≈1.2–1.4 MB/条），而 sse_connections 只看得到长连接。
check_feature "mcp inflight gauge"           "mcp_inflight"                "0.9.0-preview.160"
check_feature "mcp inflight high-water"      "mcp_inflight_peak"           "0.9.0-preview.160"

# .161 —— 告警分流（#2571）：目标忙 ⇒ queued_behind_busy_*；目标空闲/离线 ⇒ delivered_stale_*。
# 断言的是**事件名与文案的区分**，不是数量——数量要上线 24h 后才有意义。
check_feature "queued-behind-busy event"      "queued_behind_busy_"         "0.9.0-preview.161"
check_feature "stale copy distinguishes idle" "not working on another task" "0.9.0-preview.161"

# .162 —— 停顿可观测（#2614）：/health 给出事件循环单次最大 tick 间隔与最近停顿留档。
# 起因是 2026-10-26 21:55–22:12 两次 RSS 3.6/4.5 GB 尖峰：当时能看到的只有
# “请求排队变多”（mcp_inflight 387→807）和“路由变慢”（/api/stats/routes 里
# POST /api/upload 出现 178 s），但**没有任何字段说明服务端为什么卡住**，
# 只能靠事后比对日志静默手工推断。这两个字段让下次停顿自己带证据。
check_feature "event-loop stall gauge"       "event_loop"                  "0.9.0-preview.162"
check_feature "event-loop max gap"           "max_gap_ms"                  "0.9.0-preview.162"

# .163 —— 两处运维修复各自带一个可验证的锚点（#2614 / #2664 / #2622）：
#   · requests_since_last_tick —— 区分「循环阻塞」与「timer 饥饿」的判据字段（否则 84 秒的假结论会重演）；
#   · took= —— node_id 回填的耗时日志（以前只有条数，于是“0 行却花 10 秒”看不见）；
#   · COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS —— 排程连续失败退避的开关名。
check_feature "stall vs timer served count"   "requests_since_last_tick"     "0.9.0-preview.163"
check_feature "backfill duration log"         "took="                        "0.9.0-preview.163"
check_feature "schedule failure backoff knob" "COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS" "0.9.0-preview.163"

# .164 —— 两处行为改动各带一个可验证锚点（#2571 / #2668）：
#   · alias_latency_baseline —— 每目标 p99 基线的表名（告警不再用全局常数）；
#   · COMMHUB_OFFLINE_DELIVERY_TTL_MINUTES —— 投给离线目标的收尾时限开关。
check_feature "alias p99 baseline table"   "alias_latency_baseline"                  "0.9.0-preview.164"
check_feature "offline delivery ttl knob"  "COMMHUB_OFFLINE_DELIVERY_TTL_MINUTES"     "0.9.0-preview.164"

# .165 —— 启动回填延迟执行（#2664）：开关名与汇总日志都是可验证的锚点。
check_feature "deferred boot backfill knob"   "COMMHUB_BOOT_BACKFILL_DELAY_MS"        "0.9.0-preview.165"

# .166 —— 广播扇出分批（#2721）与采纳拒绝码（#1987）各带一个可 grep 的锚点。
check_feature "broadcast fan-out chunking"    "BROADCAST_CHUNK"                       "0.9.0-preview.166"
check_feature "adopt error code whitelist"    "publicAdoptError"                      "0.9.0-preview.166"

echo "== RESULT: PASS ($PKG@$VERSION)"
