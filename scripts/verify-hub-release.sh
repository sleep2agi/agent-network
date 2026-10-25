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

echo "== RESULT: PASS ($PKG@$VERSION)"
