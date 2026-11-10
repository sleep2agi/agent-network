#!/usr/bin/env bash
# 落地核实脚本的三分判定(run 42731348173 事故的回归件)—— 用桩 curl 模拟 registry,无网络。
#   可见(第 N 次才可见)            → rc 0,且 tag 落后只 warning
#   publish job 失败 + 不可见        → rc 1,措辞「publish job failed and the version is not on npm」
#   publish job 成功 + 不可见        → rc 1,措辞「已接受但从未变可见(staged/blocked/processing)」
#   publish job 被跳过               → rc 0,且**一次都不查 registry**(无事可做 ≠ 已发布)
# 另外钉住:包名要 %2F 转义、网络错误要重试、缺参数是 rc 2(用法错误,不是「没落地」)。
set -euo pipefail
VERIFY=${VERIFY:-/verify-landed.sh}
work=$(mktemp -d)
mkdir -p "$work/bin"
# 桩 curl:按 URL 分两路(版本清单 / 整包清单),每次都计数。
# 响应文件内容约定:
#   FAIL → 传输层失败(exit 22,不打印状态码)
#   404  → 打印 404,不写 body
#   其它 → 原样写进 -o 指的文件,打印 200
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
url=""; out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
echo "$url" >> "$STUB_DIR/urls"
case "$url" in
  */"$STUB_VERSION") kind=ver ;;
  *) kind=pack ;;
esac
n=$(cat "$STUB_DIR/$kind.count" 2>/dev/null || echo 0)
n=$((n + 1)); echo "$n" > "$STUB_DIR/$kind.count"
f="$STUB_DIR/$kind.$n"; [ -f "$f" ] || f="$STUB_DIR/$kind.default"
body=$(cat "$f")
if [ "$body" = FAIL ]; then exit 22; fi
if [ "$body" = 404 ]; then echo 404; [ -n "$out" ] && : > "$out"; exit 0; fi
[ -n "$out" ] && printf '%s' "$body" > "$out"
echo 200
STUB
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"

STUB_VERSION=1.0.1
export STUB_VERSION
vjson() { printf '{"name":"@x/pkg","version":"%s"}' "$1"; }
pack() { printf '{"dist-tags":{"preview":"%s"},"versions":{}}' "$1"; }

PASS=0; FAILN=0
ok()  { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAILN=$((FAILN + 1)); }

new_stub() { STUB_DIR=$(mktemp -d); export STUB_DIR; }
calls() { cat "$STUB_DIR/$1.count" 2>/dev/null || echo 0; }

# run_case <名> <PUBLISH_RESULT> <timeout_s> [额外的 KEY=VAL ...]
# 结果: $out(输出) $rc(退出码)
run_case() {
  local name="$1" result="$2" tmo="$3"; shift 3
  out=$(env PKG=@x/pkg EXPECTED="$STUB_VERSION" PUBLISH_RESULT="$result" \
        LANDED_TIMEOUT_S="$tmo" LANDED_INTERVAL_S=0.2 "$@" \
        bash "$VERIFY" 2>&1) && rc=0 || rc=$?
  printf -- '--- %s (rc=%s, ver checks=%s, packument checks=%s)\n%s\n' \
    "$name" "$rc" "$(calls ver)" "$(calls pack)" "$out"
}

# 1) 第一次就可见,且 tag 一致 → rc 0,只查一次,查的是**转义过的** registry 路径
new_stub
vjson 1.0.1 > "$STUB_DIR/ver.default"; pack 1.0.1 > "$STUB_DIR/pack.default"
run_case visible-first-try success 60
[ "$rc" = 0 ] && ok "visible on first check → rc 0" || bad "visible-first-try rc=$rc"
[ "$(calls ver)" = 1 ] && ok "visible on first check → 1 registry check" || bad "visible-first-try ver checks=$(calls ver)"
printf '%s' "$out" | grep -Fq '✅ 已落地' && ok "pass wording says landed" || bad "pass wording missing"
grep -Fq 'https://registry.npmjs.org/@x%2Fpkg/1.0.1' "$STUB_DIR/urls" \
  && ok "package name is %2F-escaped in the registry URL" || bad "registry URL not escaped: $(head -1 "$STUB_DIR/urls")"
if printf '%s' "$out" | grep -Fq '::warning::'; then bad "matching tag should not warn"; else ok "matching tag does not warn"; fi

# 2) 前两次 404,第三次可见 → rc 0,轮询到可见为止
new_stub
echo 404 > "$STUB_DIR/ver.1"; echo 404 > "$STUB_DIR/ver.2"
vjson 1.0.1 > "$STUB_DIR/ver.default"; pack 1.0.1 > "$STUB_DIR/pack.default"
run_case visible-after-2-polls success 60
[ "$rc" = 0 ] && ok "visible after 2 polls → rc 0" || bad "visible-after-2-polls rc=$rc"
[ "$(calls ver)" = 3 ] && ok "visible after 2 polls → 3 registry checks" || bad "visible-after-2-polls ver checks=$(calls ver)"

# 3) 网络错误当成「还没看到」,继续轮询(不是致命错)
new_stub
echo FAIL > "$STUB_DIR/ver.1"
vjson 1.0.1 > "$STUB_DIR/ver.default"; pack 1.0.1 > "$STUB_DIR/pack.default"
run_case curl-error-then-visible success 60
[ "$rc" = 0 ] && ok "transport error is retried, not fatal" || bad "curl-error rc=$rc"
[ "$(calls ver)" = 2 ] && ok "transport error → retried once more" || bad "curl-error ver checks=$(calls ver)"

# 4) 版本可见但 dist-tags.preview 还落后 → **仍然 rc 0**,只打 warning(tag 会滞后)
new_stub
vjson 1.0.1 > "$STUB_DIR/ver.default"; pack 1.0.0 > "$STUB_DIR/pack.default"
run_case tag-lags success 60
[ "$rc" = 0 ] && ok "lagging preview tag still passes" || bad "tag-lags rc=$rc"
printf '%s' "$out" | grep -Fq '::warning::dist-tags.preview' && ok "lagging tag is a warning, not a failure" || bad "tag-lags warning missing"

# 5) publish job 失败,但版本确实在 → rc 0(失败退出码不构成「不在 npm 上」的证据)
new_stub
vjson 1.0.1 > "$STUB_DIR/ver.default"; pack 1.0.1 > "$STUB_DIR/pack.default"
run_case publish-failed-but-visible failure 60
[ "$rc" = 0 ] && ok "failed publish + visible version → rc 0" || bad "publish-failed-but-visible rc=$rc"

# 6) publish job 失败 + 不可见 → rc 1,措辞必须是「发布失败」
new_stub
echo 404 > "$STUB_DIR/ver.default"; pack 1.0.0 > "$STUB_DIR/pack.default"
run_case publish-failed-and-invisible failure 1
[ "$rc" = 1 ] && ok "publish failed + never visible → rc 1" || bad "publish-failed-and-invisible rc=$rc"
[ "$(calls ver)" -ge 2 ] && ok "publish failed + never visible → polled more than once" || bad "publish-failed ver checks=$(calls ver)"
printf '%s' "$out" | grep -Fq 'publish job failed and the version is not on npm' \
  && ok "failed-publish wording names the publish job" || bad "failed-publish wording missing"
printf '%s' "$out" | grep -Fq 'never became visible' \
  && bad "failed-publish reuses the accepted-but-invisible wording" || ok "failed-publish is not confused with accepted-but-invisible"

# 7) publish job 成功 + 预算内始终不可见 → rc 1,措辞必须是「已接受但从未变可见」,且**不能**说成发布失败
new_stub
echo 404 > "$STUB_DIR/ver.default"; pack 1.0.0 > "$STUB_DIR/pack.default"
run_case published-but-never-visible success 1
[ "$rc" = 1 ] && ok "published + never visible → rc 1" || bad "published-but-never-visible rc=$rc"
printf '%s' "$out" | grep -Fq 'never became visible' && ok "wording says accepted but never visible" || bad "accepted-but-invisible wording missing"
printf '%s' "$out" | grep -Fq 'staged / blocked / processing' && ok "wording names staged/blocked/processing" || bad "staged/blocked/processing missing"
printf '%s' "$out" | grep -Fq 'publish job failed' && bad "accepted-but-invisible claims the publish job failed" || ok "accepted-but-invisible does not claim publish failed"
if printf '%s' "$out" | grep -Fq '没发布'; then bad "accepted-but-invisible still says 没发布"; else ok "accepted-but-invisible does not say 没发布"; fi
printf '%s' "$out" | grep -Fq 'E409' && ok "invisible case warns against re-publishing" || bad "E409 warning missing"

# 8) publish 被跳过(门红了 / 没勾 publish)→ rc 0,而且**一次都不查 registry**
new_stub
echo 404 > "$STUB_DIR/ver.default"; pack 1.0.0 > "$STUB_DIR/pack.default"
run_case skipped skipped 1
[ "$rc" = 0 ] && ok "skipped publish → rc 0 (nothing to verify)" || bad "skipped rc=$rc"
[ "$(calls ver)" = 0 ] && ok "skipped publish does not hit the registry" || bad "skipped ver checks=$(calls ver)"
printf '%s' "$out" | grep -Fq '无事可做' && ok "skipped wording distinguishes it from released" || bad "skipped wording missing"

# 9) 不给 LANDED_TIMEOUT_S 时默认上限是 15 分钟
new_stub
vjson 1.0.1 > "$STUB_DIR/ver.default"; pack 1.0.1 > "$STUB_DIR/pack.default"
out=$(PKG=@x/pkg EXPECTED="$STUB_VERSION" PUBLISH_RESULT=success bash "$VERIFY" 2>&1) && rc=0 || rc=$?
printf '%s' "$out" | grep -Fq '最长等 900s' && ok "default timeout is 15 min" || bad "default timeout wrong: $out"

# 10) 用法错误 → rc 2(不是 1:rc 1 的含义是「不可见」)
new_stub
out=$(PKG=@x/pkg EXPECTED="$STUB_VERSION" bash "$VERIFY" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "missing PUBLISH_RESULT → rc 2 (usage)" || bad "missing PUBLISH_RESULT rc=$rc"
out=$(PKG=@x/pkg EXPECTED="$STUB_VERSION" PUBLISH_RESULT=maybe bash "$VERIFY" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "unknown PUBLISH_RESULT → rc 2 (usage)" || bad "unknown PUBLISH_RESULT rc=$rc"
out=$(EXPECTED="$STUB_VERSION" PUBLISH_RESULT=success bash "$VERIFY" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "missing PKG → rc 2 (usage)" || bad "missing PKG rc=$rc"
# run 42743119409:workflow 传了目录短名,URL 恒 404,一次已落地的发布等满 15 分钟后被判红
out=$(PKG=agent-network EXPECTED="$STUB_VERSION" PUBLISH_RESULT=success LANDED_TIMEOUT_S=60 bash "$VERIFY" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "unscoped PKG → rc 2 (usage), not a 60s wait" || bad "unscoped PKG rc=$rc"
printf '%s' "$out" | grep -Fq '不是作用域包名' && ok "unscoped PKG wording names the cause" || bad "unscoped PKG wording missing: $out"
[ "$(calls ver)" = 0 ] && ok "usage errors never hit the registry" || bad "usage error ver checks=$(calls ver)"

echo "PASS=$PASS FAIL=$FAILN"
[ "$FAILN" = 0 ]
