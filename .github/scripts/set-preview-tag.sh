#!/usr/bin/env bash
# 显式收口 `dist-tags.preview`,不依赖 `npm publish --tag preview` 的副作用。
#
# 🔴 为什么要这一步(2026-11-10 实测,不是推测):
#   同一天里连着发了两版之后,registry 上出现的是这个状态:
#     · @sleep2agi/agent-node      dist-tags.preview = 2.5.0-preview.194
#     · @sleep2agi/agent-network   dist-tags.preview = 2.3.0-preview.224   ← 225 已经是 200 可见、tarball 也能下
#   也就是说 `npm i -g @sleep2agi/agent-network@preview` 装到的是 224,
#   而 194 的 agent-node 需要 226 的 CLI 才认(精确配对)。
#   ⇒ **按 tag 装出来的 CLI 和 node 是不兼容的一半对**,CLI 会直接
#     `Incompatible agent-node for opencode-cli` 拒启。
#
#   证据(同一次实测):
#     GET /@sleep2agi%2Fagent-network/2.3.0-preview.225 → 200, version=2.3.0-preview.225
#     dist.tarball → 200
#     dist.shasum  = 56287153f952bc42574c506a807d06e51e2f685c(= CI 日志里打印的 shasum)
#     dist-tags.preview 仍是 2.3.0-preview.224
#   ⇒ 字节落地了,**tag 没跟上**。这两件事必须分开断言:
#     「发出去没有」看版本 + shasum(verify-npm-publish-visible.sh / landed job);
#     「@preview 装到哪个版本」看这里。
#
# 判据(三条独立结论,不揉成一条):
#   1. 期望版本在 registry 上可见(HTTP 200 且 version 字段相符)   → 否则不能收口
#   2. 当前 preview tag 不高于期望版本                              → 否则不倒退(并发/重放保护)
#   3. `npm dist-tag add` 之后**回读 registry** 确认 tag == 期望版本 → 否则红
#
# 输入(环境变量):
#   PKG         包名(必填)
#   EXPECTED    期望版本(必填,形如 2.3.0-preview.226)
#   NPM_REGISTRY_URL     默认 https://registry.npmjs.org
#   TAG_ROLLOUT_TIMEOUT_S  回读轮询上限,秒,默认 120(给了 TAG_ROLLOUT_TIMEOUT_MIN 走分钟)
#
# 退出码:0 = tag 已指向期望版本(或已由并发发版指向更高版本)｜1 = 没做到｜2 = 用法错误
set -euo pipefail

usage_error() { echo "::error::$1" >&2; exit 2; }

# ── 自检:用桩 curl/npm 跑三条判据,不联网 ──────────────────────────────────
# 放在脚本里而不是新开一套 tests/,是因为这个脚本的判据只有三格,
# 而新加的测试套件还要过 test-inventory / orphan 那一整套登记门;
# 仓里已有 `scripts/lib/curl-exit.sh --selftest` 这个先例。
selftest() {
  local work pass=0 fail=0
  work=$(mktemp -d)
  trap 'rm -rf "$work"' RETURN
  mkdir -p "$work/bin"

  # 桩 curl:按 $STUB_DIR/resp.<n> 回复(没有就 resp.default),内容 = "<http_code>\n<body>"
  cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
url="${!#}"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
f="$STUB_DIR/resp.$n"; [ -f "$f" ] || f="$STUB_DIR/resp.default"
code=$(head -1 "$f"); body=$(tail -n +2 "$f")
[ -n "$body" ] && [ -n "$out" ] && printf '%s' "$body" > "$out"
printf '%s' "$code"
STUB
  cat > "$work/bin/npm" <<'STUB'
#!/usr/bin/env bash
echo "npm $*" >> "$STUB_DIR/npm.log"
[ "$1" = "dist-tag" ] || exit 0
# 成功收口后,把桩 registry 的 preview 改成期望版本
echo 200 > "$STUB_DIR/resp.default"
printf '{"dist-tags":{"preview":"%s"}}' "${3##*@}" >> "$STUB_DIR/resp.default"
exit 0
STUB
  chmod +x "$work/bin/curl" "$work/bin/npm"
  export PATH="$work/bin:$PATH"

  run() { # run <name> <expect_rc> <stub files...>
    local name="$1" want="$2"; shift 2
    STUB_DIR=$(mktemp -d -p "$work"); export STUB_DIR
    local i=1
    for f in "$@"; do printf '%s' "$f" > "$STUB_DIR/resp.$i"; i=$((i+1)); done
    : > "$STUB_DIR/npm.log"
    out=$(PKG=@x/pkg EXPECTED=2.3.0-preview.226 TAG_ROLLOUT_TIMEOUT_S=0 \
          bash "$0" 2>&1) && rc=0 || rc=$?
    if [ "$rc" = "$want" ]; then echo "PASS: $name (rc=$rc)"; pass=$((pass+1));
    else echo "FAIL: $name (rc=$rc, want $want)"; echo "$out" | sed 's/^/    /'; fail=$((fail+1)); fi
  }

  # 1) 期望版本可见、tag 落后 → 应当收口并回读通过
  run "moves stale tag forward" 0 \
      '200
{"version":"2.3.0-preview.226"}' \
      '200
{"dist-tags":{"preview":"2.3.0-preview.224"}}'

  # 2) tag 已经更高(并发发版跑在前面)→ 不倒退,rc 0 且说明原因
  STUB_DIR=$(mktemp -d -p "$work"); export STUB_DIR
  printf '200\n{"version":"2.3.0-preview.226"}' > "$STUB_DIR/resp.1"
  printf '200\n{"dist-tags":{"preview":"2.3.0-preview.227"}}' > "$STUB_DIR/resp.default"
  : > "$STUB_DIR/npm.log"
  out=$(PKG=@x/pkg EXPECTED=2.3.0-preview.226 TAG_ROLLOUT_TIMEOUT_S=0 bash "$0" 2>&1) && rc=0 || rc=$?
  if [ "$rc" = 0 ] && ! grep -q "dist-tag add" "$STUB_DIR/npm.log" && echo "$out" | grep -q "不倒退"; then
    echo "PASS: refuses to move the tag backwards (rc=0)"; pass=$((pass+1))
  else echo "FAIL: backwards guard (rc=$rc)"; echo "$out" | sed 's/^/    /'; fail=$((fail+1)); fi

  # 3) 期望版本根本不可见 → 不能收口,rc 1
  run "refuses when the version is not visible" 1 '404
{"error":"Not found"}'

  echo "PASS=$pass FAIL=$fail"
  [ "$fail" = 0 ]
}

if [ "${1:-}" = "--selftest" ]; then selftest; exit $?; fi

[ -n "${PKG:-}" ] || usage_error 'PKG 必填'
[ -n "${EXPECTED:-}" ] || usage_error 'EXPECTED 必填'

registry="${NPM_REGISTRY_URL:-https://registry.npmjs.org}"
rollout_timeout_s="${TAG_ROLLOUT_TIMEOUT_S:-$(( ${TAG_ROLLOUT_TIMEOUT_MIN:-2} * 60 ))}"
enc=${PKG//\//%2F}
ver_url="$registry/$enc/$EXPECTED"
pack_url="$registry/$enc"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

http_get() { # http_get <url> <outfile> → HTTP 状态码;传输层失败 = 000
  local code
  code=$(curl -sS -o "$2" -w '%{http_code}' --max-time 20 -H 'Cache-Control: no-cache' "$1" 2>/dev/null) || code=000
  printf '%s' "$code"
}

json_version() { # <json-file> → 该清单的 version 字段(解析失败打印空)
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v="";
    try{v=String(JSON.parse(s).version||"")}catch{}
    console.log(v)});' < "$1"
}

json_preview_tag() { # <packument-file> → dist-tags.preview(解析失败打印空)
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v="";
    try{v=String((JSON.parse(s)["dist-tags"]||{}).preview||"")}catch{}
    console.log(v)});' < "$1"
}

# 版本序:只认 <...>-preview.<n> 这种本仓真实形状;认不出就不做比较(避免瞎倒退)
preview_seq() { sed -nE 's/^.*-preview\.([0-9]+)$/\1/p' <<< "$1"; }

echo "收口 $PKG 的 preview tag → $EXPECTED"

# 判 1:版本必须先在 registry 上可见,否则设 tag 只会失败(或被 npm 静默忽略)
code=$(http_get "$ver_url" "$tmp/version.json")
seen=$(json_version "$tmp/version.json")
if [ "$code" != 200 ] || [ "$seen" != "$EXPECTED" ]; then
  echo "::error::不能收口:$EXPECTED 目前还不可见(GET $ver_url → HTTP $code,version='${seen}')。tag 未改动 —— 指向一个不存在的版本比指向旧版本更坏。"
  exit 1
fi
echo "版本已可见:$EXPECTED"

# 判 2:不倒退(并发发版/重放时,较老的 run 不许把 tag 拉回去)
cur=""
if [ "$(http_get "$pack_url" "$tmp/pack.json")" = 200 ]; then
  cur=$(json_preview_tag "$tmp/pack.json")
fi
echo "当前 preview tag:${cur:-<读不到>}"
if [ -n "$cur" ] && [ "$cur" = "$EXPECTED" ]; then
  echo "✅ 已经是 $EXPECTED,无需改动"
  exit 0
fi
cur_seq=$(preview_seq "$cur"); want_seq=$(preview_seq "$EXPECTED")
if [ -n "$cur_seq" ] && [ -n "$want_seq" ] && [ "$cur_seq" -gt "$want_seq" ]; then
  echo "✅ 不倒退:当前 tag 是 $cur,高于本次要发的 $EXPECTED —— 说明更晚的版本已经发过并把 tag 拿走了。跳过,不改动。"
  exit 0
fi

# 判 3:显式设置 + 回读 registry(不信 npm 的退出码,也不信 CDN)
echo "执行:npm dist-tag add $PKG@$EXPECTED preview"
if ! npm dist-tag add "$PKG@$EXPECTED" preview; then
  echo "::error::npm dist-tag add 失败 —— tag 没有指向 $EXPECTED,@preview 装的仍是旧版本(按 tag 安装会拿到不配对的 CLI/node)。"
  exit 1
fi

deadline=$((SECONDS + rollout_timeout_s))
while :; do
  if [ "$(http_get "$pack_url" "$tmp/pack.json")" = 200 ]; then
    cur=$(json_preview_tag "$tmp/pack.json")
  fi
  echo "回读:preview=$cur"
  if [ "$cur" = "$EXPECTED" ]; then
    echo "✅ preview tag 已指向 $EXPECTED(回读 registry 确认)"
    exit 0
  fi
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 10
done

echo "::error::dist-tag add 已执行,但回读 ${rollout_timeout_s}s 后 preview 仍是 '${cur}',不是 $EXPECTED —— 按 tag 安装会拿到不配对的版本,必须人工核对。"
exit 1
