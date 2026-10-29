#!/usr/bin/env bash
# #1510 续：发布脚本的三种判定 —— 用桩 npm 模拟，无网络。
#
#   ① 透明度日志冲突（409 equivalent entry already exists）⇒ rc 0，交给发后核实
#   ② 鉴权失败（403）                                       ⇒ rc 1，绝不能被放成绿
#   ③ 发布成功                                              ⇒ rc 0
#
# 为什么值得单独测：这条判据错在任何一边都很难发现。
#   放行真失败 → 「发版成功」但 registry 上没有，人第二天才发现线上还是旧版；
#   拦截 409   → 明明发出去了却红，人重跑、再撞 409、再重跑。
set -uo pipefail

WORK=$(mktemp -d)
mkdir -p "$WORK/bin"
cat > "$WORK/bin/npm" <<'STUB'
#!/usr/bin/env bash
case "${STUB_SCRIPT:-ok}" in
  ok)   exit 0 ;;
  tlog) echo "npm error code TLOG_CREATE_ENTRY_ERROR"
        echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log"
        exit 1 ;;
  auth) echo "npm error code E403"
        echo "npm error 403 Forbidden - PUT https://registry.npmjs.org/@scope%2fpkg - You do not have permission"
        exit 1 ;;
esac
STUB
chmod +x "$WORK/bin/npm"
export PATH="$WORK/bin:$PATH"

PUBLISH=/work/.github/scripts/publish-with-tlog-recover.sh
FAIL=0
# 用 if 调用而不是「跑完看 $?」：脚本自带 set -e，普通调用失败会把测试脚本一起掐掉。
run() { # run <说明> <期望 rc> <期望输出里的子串|"">
  local name="$1" want="$2" needle="${3:-}"
  local rc=0
  if "$PUBLISH" /tmp/fake.tgz preview >"$WORK/out" 2>&1; then rc=0; else rc=$?; fi
  if [ "$rc" != "$want" ]; then
    echo "  ✗ $name → rc=$rc（期望 $want）"; sed 's/^/      /' "$WORK/out"; FAIL=1; return
  fi
  if [ -n "$needle" ] && ! grep -q -- "$needle" "$WORK/out"; then
    echo "  ✗ $name → rc 对但输出里没有「$needle」"; sed 's/^/      /' "$WORK/out"; FAIL=1; return
  fi
  echo "  ✓ $name → rc=$rc"
}

echo "① 透明度日志冲突（409）不该判死"
STUB_SCRIPT=tlog run "409 → 交给发后核实" 0 "发后核实"

echo "② 鉴权失败必须真红"
STUB_SCRIPT=auth run "403 → 真失败" 1 "真失败"

echo "③ 正常发布"
STUB_SCRIPT=ok run "发布成功" 0

if [ "$FAIL" != 0 ]; then echo "publish-tlog-recover: FAILED"; exit 1; fi
echo "publish-tlog-recover: OK (3 个判定)"
