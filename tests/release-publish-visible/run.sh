#!/usr/bin/env bash
# #582:发后核实脚本的三种判定 —— 用桩 curl 模拟 registry,无网络。
#   可见(第 N 次才可见)→ rc 0
#   从不可见           → 超时,rc 1,措辞「尚未核实」而不是「没生效」
#   可见但字节不符     → 立即 rc 1,不轮询
set -euo pipefail
VERIFY=${VERIFY:-/verify.sh}
work=$(mktemp -d)
mkdir -p "$work/bin"
# 桩 curl:第 k 次调用输出 $STUB_DIR/resp.<k>(没有就用 resp.default);
# 文件内容为 FAIL 时模拟网络错误(exit 22)。
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
f="$STUB_DIR/resp.$n"; [ -f "$f" ] || f="$STUB_DIR/resp.default"
if [ "$(cat "$f")" = FAIL ]; then exit 22; fi
cat "$f"
STUB
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"

GOOD=1111111111111111111111111111111111111111
BAD=2222222222222222222222222222222222222222
doc() { # doc <preview-tag> <shasum-of-1.0.1 or empty>
  if [ -n "$2" ]; then
    printf '{"dist-tags":{"preview":"%s"},"versions":{"1.0.0":{"dist":{"shasum":"x"}},"1.0.1":{"dist":{"shasum":"%s"}}}}' "$1" "$2"
  else
    printf '{"dist-tags":{"preview":"%s"},"versions":{"1.0.0":{"dist":{"shasum":"x"}}}}' "$1"
  fi
}
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# run_case <name> <timeout_s>; 输出存 $out,退出码存 $rc,桩调用次数存 $calls
run_case() {
  out=$(PKG=@x/pkg EXPECTED=1.0.1 LOCAL_SHA1=$GOOD VERIFY_TIMEOUT_S="$2" VERIFY_INTERVAL_S=0 \
        bash "$VERIFY" 2>&1) && rc=0 || rc=$?
  calls=$(cat "$STUB_DIR/count" 2>/dev/null || echo 0)
  printf -- '--- %s (rc=%s, curl calls=%s)\n%s\n' "$1" "$rc" "$calls" "$out"
}
new_stub() { STUB_DIR=$(mktemp -d); export STUB_DIR; }

# 1) 前两次旧版本,第三次可见 → 通过
new_stub
doc 1.0.0 "" > "$STUB_DIR/resp.1"; doc 1.0.0 "" > "$STUB_DIR/resp.2"; doc 1.0.1 "$GOOD" > "$STUB_DIR/resp.default"
run_case visible-after-2-polls 60
[ "$rc" = 0 ] && [ "$calls" = 3 ] && ok "visible after 2 polls → rc 0 on 3rd check" || bad "visible-after-2-polls rc=$rc calls=$calls"

# 2) 版本已可见、tag 还落后 → 继续等,tag 跟上后通过(两条都要成立)
new_stub
doc 1.0.0 "$GOOD" > "$STUB_DIR/resp.1"; doc 1.0.1 "$GOOD" > "$STUB_DIR/resp.default"
run_case tag-lags-shasum 60
[ "$rc" = 0 ] && [ "$calls" = 2 ] && ok "tag lagging keeps polling, passes once tag moves" || bad "tag-lags rc=$rc calls=$calls"

# 2b) tag 已指向新版本、shasum 还看不到 → 不能只凭 tag 放行
new_stub
doc 1.0.1 "" > "$STUB_DIR/resp.1"; doc 1.0.1 "$GOOD" > "$STUB_DIR/resp.default"
run_case tag-before-shasum 60
[ "$rc" = 0 ] && [ "$calls" = 2 ] && ok "tag alone is not enough, waits for shasum" || bad "tag-before-shasum rc=$rc calls=$calls"

# 3) 网络错误也是「还没看到」,继续轮询
new_stub
echo FAIL > "$STUB_DIR/resp.1"; doc 1.0.1 "$GOOD" > "$STUB_DIR/resp.default"
run_case curl-error-then-visible 60
[ "$rc" = 0 ] && [ "$calls" = 2 ] && ok "fetch error is retried, not fatal" || bad "curl-error rc=$rc calls=$calls"

# 4) 从不可见 → 超时:rc 1,「尚未核实」,不出现「没生效」,提示 npm view 和别重发
new_stub
doc 1.0.0 "" > "$STUB_DIR/resp.default"
run_case never-visible 1
[ "$rc" = 1 ] && ok "never visible → rc 1" || bad "never-visible rc=$rc"
[ "$calls" -ge 2 ] && ok "never visible → polled more than once ($calls)" || bad "never-visible calls=$calls"
printf '%s' "$out" | grep -Fq '尚未核实(不是发布被拒)' && ok "timeout message says not-yet-verified" || bad "timeout wording missing"
printf '%s' "$out" | grep -Fq 'npm view @x/pkg@1.0.1 dist.shasum' && ok "timeout message gives npm view command" || bad "npm view hint missing"
printf '%s' "$out" | grep -Fq 'E409' && ok "timeout message warns against re-publish" || bad "E409 warning missing"
if printf '%s' "$out" | grep -Fq '没生效'; then bad "timeout still claims 没生效"; else ok "timeout does not claim 没生效"; fi

# 5) 可见但字节不符 → 立即 rc 1(只查 1 次;若被改成轮询,会查满 3s 才退)
new_stub
doc 1.0.1 "$BAD" > "$STUB_DIR/resp.default"
run_case shasum-mismatch 3
[ "$rc" = 1 ] && [ "$calls" = 1 ] && ok "shasum mismatch → immediate rc 1 (1 check)" || bad "mismatch rc=$rc calls=$calls"
printf '%s' "$out" | grep -Fq '字节不符' && ok "mismatch message distinct" || bad "mismatch wording missing"
if printf '%s' "$out" | grep -Fq '尚未核实'; then bad "mismatch uses timeout wording"; else ok "mismatch not confused with timeout"; fi

# 6) 默认上限确实是 15 分钟(不给 VERIFY_TIMEOUT_S 时)
new_stub
doc 1.0.1 "$GOOD" > "$STUB_DIR/resp.default"
out=$(PKG=@x/pkg EXPECTED=1.0.1 LOCAL_SHA1=$GOOD bash "$VERIFY" 2>&1) && rc=0 || rc=$?
printf '%s' "$out" | grep -Fq '最长等 900s' && ok "default timeout is 15 min" || bad "default timeout: $out"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
