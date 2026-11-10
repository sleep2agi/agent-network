#!/usr/bin/env bash
# 升 latest 的全量 QA 闸(check-full-qa-for-latest.sh)—— 桩 curl(provenance)+ 桩 gh(qa.yml 运行记录),
# 真 git 历史,无网络。钉住:
#   · 取「最早」覆盖源 commit 的全量运行,而不是最新的
#   · PR 事件的运行不算全量;cancelled 跳过
#   · 没有覆盖 / 覆盖为红 / 没有 provenance / provenance 来自别的 workflow → rc 1
#   · 用法错误 → rc 2
set -euo pipefail
CHECK=${CHECK:-/check.sh}
work=$(mktemp -d)
mkdir -p "$work/bin"

repo="$work/repo"
git init -q -b main "$repo"
cd "$repo"
git config user.email t@example.com; git config user.name t
for i in 1 2 3 4; do echo "$i" > f; git add f; git commit -qm "c$i"; done
C1=$(git rev-parse HEAD~3); C2=$(git rev-parse HEAD~2); C3=$(git rev-parse HEAD~1); C4=$(git rev-parse HEAD)

cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in http*) echo "$a" >> "$STUB_DIR/urls" ;; esac; done
[ -f "$STUB_DIR/attestation" ] || exit 22
cat "$STUB_DIR/attestation"
STUB
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/gh-args"
[ -f "$STUB_DIR/runs.tsv" ] || exit 1
cat "$STUB_DIR/runs.tsv"
STUB
chmod +x "$work/bin/curl" "$work/bin/gh"
export PATH="$work/bin:$PATH"

# provenance <commit> [repo] [workflow path]
provenance() {
  local payload
  payload=$(printf '{"predicate":{"buildDefinition":{"externalParameters":{"workflow":{"repository":"https://github.com/%s","path":"%s"}},"resolvedDependencies":[{"digest":{"gitCommit":"%s"}}]}}}' \
    "${2:-o/r}" "${3:-.github/workflows/release.yml}" "$1" | base64 -w0)
  printf '{"attestations":[{"predicateType":"https://slsa.dev/provenance/v1","bundle":{"dsseEnvelope":{"payload":"%s"}}}]}' "$payload" \
    > "$STUB_DIR/attestation"
}
# runs 行:<head_sha>\t<conclusion>\t<url>,新→旧(gh --jq 已过滤掉 PR 事件)
runs() { printf '%b' "$1" > "$STUB_DIR/runs.tsv"; }

PASS=0; FAILN=0
ok()  { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAILN=$((FAILN + 1)); }
new_stub() { STUB_DIR=$(mktemp -d); export STUB_DIR; }
run_check() {
  out=$(env PKG=@x/pkg VERSION=1.0.0 REPO=o/r "$@" bash "$CHECK" 2>&1) && rc=0 || rc=$?
  printf -- '--- rc=%s\n%s\n' "$rc" "$out"
}

# 1) 源 C2;覆盖它的有 C4(红,之后的改动)和 C3(绿,最早)→ 用 C3,rc 0
new_stub; provenance "$C2"
runs "$C4\tfailure\tu4\n$C3\tsuccess\tu3\n$C1\tfailure\tu1\n"
run_check
[ "$rc" = 0 ] && ok "earliest covering run green → rc 0" || bad "earliest-green rc=$rc"
printf '%s' "$out" | grep -Fq 'u3' && ok "picks the earliest covering run (u3), not the newest" || bad "wrong run picked"
grep -Fq '/-/npm/v1/attestations/@x%2fpkg@1.0.0' "$STUB_DIR/urls" && ok "reads provenance from the attestations endpoint" || bad "attestation URL: $(cat "$STUB_DIR/urls")"
grep -Fq 'actions/workflows/qa.yml/runs?branch=main' "$STUB_DIR/gh-args" && ok "reads qa.yml runs on main" || bad "gh args: $(cat "$STUB_DIR/gh-args")"
grep -Fq 'select(.event=="schedule" or .event=="workflow_dispatch")' "$STUB_DIR/gh-args" && ok "PR (fast-tier) runs are not counted as full QA" || bad "event filter missing"

# 2) 最早覆盖的是红,之后变绿 → 仍 rc 1(绿的那次混入了版本之外的修复)
new_stub; provenance "$C2"
runs "$C4\tsuccess\tu4\n$C2\tfailure\tu2\n"
run_check
[ "$rc" = 1 ] && ok "earliest covering run red → rc 1 even if a later one is green" || bad "earliest-red rc=$rc"
printf '%s' "$out" | grep -Fq 'u2' && ok "red verdict names the covering run" || bad "red verdict url missing"

# 3) cancelled 不算数 —— 跳过它,看下一次
new_stub; provenance "$C2"
runs "$C4\tsuccess\tu4\n$C3\tcancelled\tu3\n$C1\tsuccess\tu1\n"
run_check
[ "$rc" = 0 ] && printf '%s' "$out" | grep -Fq 'u4' && ok "cancelled run is skipped" || bad "cancelled rc=$rc"

# 4) 没有覆盖源 commit 的全量运行 → rc 1,提示手动跑一次
new_stub; provenance "$C4"
runs "$C3\tsuccess\tu3\n"
run_check
[ "$rc" = 1 ] && ok "no covering run → rc 1" || bad "no-cover rc=$rc"
printf '%s' "$out" | grep -Fq 'workflow_dispatch' && ok "no-cover wording says how to get coverage" || bad "no-cover wording missing"

# 5) 没有 provenance → rc 1
new_stub
runs "$C4\tsuccess\tu4\n"
run_check
[ "$rc" = 1 ] && printf '%s' "$out" | grep -Fq '取不到' && ok "missing provenance → rc 1" || bad "no-provenance rc=$rc"

# 6) provenance 来自别的仓 / 别的 workflow → rc 1
new_stub; provenance "$C2" evil/fork
runs "$C4\tsuccess\tu4\n"
run_check
[ "$rc" = 1 ] && ok "provenance from another repo → rc 1" || bad "other-repo rc=$rc"
new_stub; provenance "$C2" o/r .github/workflows/other.yml
runs "$C4\tsuccess\tu4\n"
run_check
[ "$rc" = 1 ] && ok "provenance from another workflow → rc 1" || bad "other-workflow rc=$rc"

# 7) 源 commit 不在本地历史里 → rc 1
new_stub; provenance 0123456789abcdef0123456789abcdef01234567
runs "$C4\tsuccess\tu4\n"
run_check
[ "$rc" = 1 ] && ok "unknown source commit → rc 1" || bad "unknown-commit rc=$rc"

# 8) 用法错误 → rc 2,且不碰网络
new_stub
out=$(VERSION=1 REPO=o/r bash "$CHECK" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "missing PKG → rc 2" || bad "missing PKG rc=$rc"
out=$(PKG=agent-network VERSION=1 REPO=o/r bash "$CHECK" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "unscoped PKG → rc 2" || bad "unscoped PKG rc=$rc"
[ ! -f "$STUB_DIR/urls" ] && ok "usage errors never hit the network" || bad "usage error hit network"

echo "PASS=$PASS FAIL=$FAILN"
[ "$FAILN" = 0 ]
