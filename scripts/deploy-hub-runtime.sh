#!/usr/bin/env bash
# 生产 hub 运行时切换：装 → 验 → 切 → 回读 → 失败即回滚。
#
# 2026-10-31 —— 这两件事接连发生：
#   ① 我用「registry 刚发完、npm 缓存没刷新」的那一次 install 失败，直接重启了生产
#      ⇒ 生产 5 分钟不可用（381 个会话连不上）。
#   ② 外部复核：「当一个判据是 N 个合取项时，诊断要报**哪一位**没对上，不要只报没对上」。
#
# 所以本脚本把「失败」拆成**封闭的 stage 枚举**，每个 stage 一个退出码：
#
#   stage=registry_missing     (10)  npm 上没有这个版本（还没发出去 / 通道不对）
#   stage=install_failed       (11)  npm install 失败（缓存、网络、权限）
#   stage=install_version_mismatch (12) 装完读到的版本与目标不符（缓存命中了旧包）
#   stage=health_unreachable   (13)  切换后 /health 读不到
#   stage=health_version_mismatch (14) 切换后版本不是目标（多半指错了目录）
#   stage=rollback_failed      (15)  回滚也没起来 —— 这时候只能人工介入
#   stage=home_not_found       (16)  COMMHUB_HOME 不存在（拷脚本到别的机器时最常见的错）
#   stage=pm2_missing          (17)  找不到 pm2 可执行文件（**今天真的发生过**）
#   stage=switch_failed        (18)  pm2 restart 返回非 0（切换没执行，但旧进程还活着）
#   stage=unsafe_runtime_path  (19)  运行时目录不在 COMMHUB_HOME 里 —— 拒绝切换（**今天真的发生过**）
#   stage=observe_window_failed(21)  切换后观察窗口内 degraded/版本漂移/会话归零 —— 已回滚
#   stage=build_identity_absent(22)  制品里有 build-info.json，但 /health 的 build_identified 不是 true
#                                    ⇒ 进程没从这份字节起（**不回滚**：版本与健康都正常，这里只是没对上身份）
#
# 判据：**「没成功」与「哪一步没成功」是两句话**；后一句才能决定下一步做什么
# （registry 缺失 ⇒ 去发版；install 失败 ⇒ 清缓存；health 不通 ⇒ 立刻回滚）。
#
# 用法：
#   scripts/deploy-hub-runtime.sh --version 0.9.0-preview.224 [--dry-run]
#   PM2_NAME=3 HUB_URL=http://127.0.0.1:9200 scripts/deploy-hub-runtime.sh --version …

set -uo pipefail

VERSION=""
DRY=0
PM2_NAME="${PM2_NAME:-3}"
HUB_URL="${HUB_URL:-http://127.0.0.1:9200}"
COMMHUB_HOME="${COMMHUB_HOME:-$HOME/.commhub}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    *) echo "用法: $0 --version <x.y.z[-preview.N]> [--dry-run]" >&2; exit 2 ;;
  esac
done

stage_fail() { printf 'stage=%s\n  ⇒ %s\n' "$1" "$2" >&2; exit "$3"; }
say() { printf '  %s\n' "$*"; }

# 2026-10-31 —— 生产上真的踩到了：`pm2` 不在 PATH 时
#   `HUB_RUNTIME_DIR=… pm2 restart … >/dev/null 2>&1` 静默失败 ⇒ 旧进程继续跑
#   ⇒ 回读仍是旧版本 ⇒ 脚本报 health_version_mismatch（**指向了错误的 stage**）。
# 判据：**重定向到 /dev/null 的那一行，必须紧跟一次退出码检查**；
#       否则「没执行」和「执行了但没生效」在日志里是同一行。
resolve_pm2() {
  if command -v pm2 >/dev/null 2>&1; then command -v pm2; return 0; fi
  local c
  for c in "$HOME"/.nvm/versions/node/*/bin/pm2 /usr/local/bin/pm2 /usr/bin/pm2; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

pm2_restart() { # $1=runtime dir  ⇒ 成功 0 / 失败非 0（**不**打印，由调用方决定 stage）
  local dir="$1" out rc
  out=$(HUB_RUNTIME_DIR="$dir" "$PM2_BIN" restart "$PM2_NAME" --update-env 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    printf '%s\n' "$out" | tail -3 >&2
  fi
  return $rc
}

health_version() {
  local body
  body=$(curl -s --max-time 6 "$HUB_URL/health" 2>/dev/null) || return 1
  printf '%s' "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('version',''))" 2>/dev/null
}

if [ "${SELFTEST:-0}" = "1" ]; then
  # 只自检「stage 枚举是封闭且互不相同」这条契约 —— 真装/真切换不适合在自检里跑。
  fails=0
  codes="10 11 12 13 14 15 16 17 18 19 21"
  # 20 刻意留空：它曾经属于一个被删掉的 stage，跳号比复用旧号安全（旧日志还能对上）
  n=$(printf '%s\n' $codes | sort -u | wc -l | tr -d ' ')
  [ "$n" = "11" ] && echo "✓ selftest stage 退出码 11 个且互不相同（20 刻意留空）" || { echo "✗ stage 退出码有重复"; fails=$((fails+1)); }
  for s in registry_missing install_failed install_version_mismatch health_unreachable health_version_mismatch rollback_failed home_not_found pm2_missing switch_failed unsafe_runtime_path observe_window_failed; do
    grep -q "stage=$s" "$0" && echo "✓ selftest 登记了 stage=$s" || { echo "✗ 缺 stage=$s"; fails=$((fails+1)); }
  done
  [ "$fails" -eq 0 ] && { echo "✓ selftest 全部通过"; exit 0; }
  exit 1
fi

[ -n "$VERSION" ] || { echo "用法: $0 --version <版本> [--dry-run]" >&2; exit 2; }
if [ ! -d "$COMMHUB_HOME" ]; then
  stage_fail home_not_found "COMMHUB_HOME=$COMMHUB_HOME 不存在 —— 生产上要显式给 COMMHUB_HOME=\$HOME/.commhub" 16
fi
RUNTIME_DIR="$COMMHUB_HOME/runtime-${VERSION//./-}"
CURRENT="$(health_version || true)"
say "当前线上版本：${CURRENT:-读不到}"
say "目标版本：$VERSION ｜ 运行时目录：$RUNTIME_DIR"
[ "$DRY" = "1" ] && { say "dry-run：只打印，不做任何改动"; exit 0; }

# ① registry 上有没有这个版本（刚发完时 npm 缓存可能还没跟上，所以先问 registry 而不是直接装）
if ! npm view "@sleep2agi/commhub-server@$VERSION" version >/dev/null 2>&1; then
  stage_fail registry_missing "npm 上看不到 $VERSION —— 先确认已经发布、或通道是 preview" 10
fi

# ② 装到独立运行时目录（不动当前在跑的那一份）
rm -rf "$RUNTIME_DIR"
if ! npm install --no-audit --no-fund --prefix "$RUNTIME_DIR" "@sleep2agi/commhub-server@$VERSION" >/dev/null 2>&1; then
  stage_fail install_failed "npm install 失败 —— 先 npm cache verify，再重试；**不要**带着半装目录去重启" 11
fi

# ③ 验证装到的字节（这一条正是那次 5 分钟中断缺的东西）
INSTALLED=$(node -e "try{console.log(require('$RUNTIME_DIR/node_modules/@sleep2agi/commhub-server/package.json').version)}catch(e){process.exit(1)}" 2>/dev/null)
if [ "$INSTALLED" != "$VERSION" ]; then
  stage_fail install_version_mismatch "装到的是 ${INSTALLED:-（读不到）}，不是 $VERSION —— 缓存命中了旧包" 12
fi
say "install ok：$INSTALLED"

# ③b 路径包含性：运行时目录必须在 COMMHUB_HOME 之内。
# 2026-10-31 —— 我为了「验证 pm2_missing 这个 stage」用 COMMHUB_HOME=/tmp/fakehub 跑了一次真实执行，
#   以为换掉 COMMHUB_HOME 就是沙箱；但 restart **不读 COMMHUB_HOME**，它读 RUNTIME_DIR
#   ⇒ pm2 把**生产**从真目录切到了 /tmp/fakehub/...（版本号相同，所以 /health 一切正常，
#     唯一能看出来的地方是 `pm2 env 3` 里的 HUB_RUNTIME_DIR）。
# 判据：**一个沙箱只有覆盖了「会改变全局状态的那一步」才算沙箱**；
#       换输入变量 ≠ 换输出目的地。这里让「目的地不在允许范围」直接变成 stage 19。
# ⚠️ 第一版守护写成「RUNTIME_DIR 是否在 COMMHUB_HOME 之内」——那是**恒真**的
# （RUNTIME_DIR 就是由 COMMHUB_HOME 拼出来的）= 一条保护不了任何东西的断言。
# 真正要挡的是：**拿一个非生产 home 去重启生产进程**。所以判据换成「home 必须是生产 home」。
PROD_HOME="${PROD_COMMHUB_HOME:-$HOME/.commhub}"
if [ "$COMMHUB_HOME" != "$PROD_HOME" ] && [ "${ALLOW_NONPROD_HOME:-0}" != "1" ]; then
  stage_fail unsafe_runtime_path "COMMHUB_HOME=$COMMHUB_HOME 不是生产 home（$PROD_HOME）⇒ 拒绝切换：restart 不读 COMMHUB_HOME，它会把这个**生产进程**指到别的目录去。要演练请显式 ALLOW_NONPROD_HOME=1" 19
fi

# ④ 切换
PM2_BIN="$(resolve_pm2)" || stage_fail pm2_missing "PATH 里没有 pm2，常见位置也没找到 ⇒ 切换**没有执行**（旧进程仍在跑，无需回滚）。把 pm2 所在 bin 加进 PATH 后重试" 17
HUB_RUNTIME_DIR="$RUNTIME_DIR" "$PM2_BIN" restart "$PM2_NAME" --update-env >/dev/null 2>&1 \
  || stage_fail switch_failed "$PM2_BIN restart $PM2_NAME 返回非 0（切换没发生；旧进程仍在跑）。看 pm2 logs $PM2_NAME" 18
sleep 9

# ⑤ 回读；失败立刻回滚到切换前的版本
NEWV=$(health_version)
if [ -z "$NEWV" ]; then
  # 2026-10-31 —— 外部复核：「当『修好』会解锁一个会造成全量故障的路径时，
  # 修复动作本身是一个新的发布风险。」新版本可能**起不来**（例如启动期断言拒绝了配置），
  # 那时只打印「立刻回滚」是不够的：脚本必须在同一次执行里真的回滚，
  # 否则「gate 通过 + 起不来」就变成一次需要人值守的窗口。
  if [ -n "$CURRENT" ]; then
    say "新版本起不来 ⇒ 自动回滚到 $CURRENT"
    pm2_restart "$COMMHUB_HOME/runtime-${CURRENT//./-}" || true   # 失败会在下面的回读里体现
    sleep 8
    BACK=$(health_version)
    if [ "$BACK" = "$CURRENT" ]; then
      stage_fail health_unreachable "新版本 /health 读不到；**已自动回滚到 $CURRENT**（服务可用）" 13
    fi
    stage_fail rollback_failed "新版本读不到，回滚到 $CURRENT 也没起来（现在是 ${BACK:-读不到}）—— 需要人工介入" 15
  fi
  stage_fail health_unreachable "/health 读不到，且不知道切换前版本，无法自动回滚" 13
fi
if [ "$NEWV" != "$VERSION" ]; then
  if [ -n "$CURRENT" ]; then
    pm2_restart "$COMMHUB_HOME/runtime-${CURRENT//./-}" || true   # 失败会在下面的回读里体现
    sleep 8
    BACK=$(health_version)
    if [ "$BACK" != "$CURRENT" ]; then
      stage_fail rollback_failed "回滚到 $CURRENT 也失败（现在是 ${BACK:-读不到}）—— 需要人工介入" 15
    fi
    stage_fail health_version_mismatch "切换后是 $NEWV，不是 $VERSION；已回滚到 $CURRENT" 14
  fi
  stage_fail health_version_mismatch "切换后是 $NEWV，不是 $VERSION；且不知道原版本，无法自动回滚" 14
fi

pm2 save >/dev/null 2>&1
say "切换完成：$CURRENT → $NEWV（pm2 save 已执行）"

# ⑤b 观察窗口（外部复核：「一个动作若会改变『谁能受害』，它的风险等级就等于一次发布；
#   门槛是**回滚、顺序、观察窗口**三件，不是『改动很小』。」）
# 回滚与顺序本脚本已有；缺的是**观察窗口** —— 切换成功那一刻的 /health 只说明它起来了，
# 不说明它稳。窗口内出现 degraded / 版本漂移 / 会话数归零 ⇒ 当作失败并回滚。
OBSERVE_S="${OBSERVE_S:-30}"
say "观察窗口：${OBSERVE_S}s（每 10s 采一次 /health）"
elapsed=0
while [ "$elapsed" -lt "$OBSERVE_S" ]; do
  sleep 10
  elapsed=$((elapsed + 10))
  BODY=$(curl -s --max-time 6 "$HUB_URL/health" 2>/dev/null)
  if [ -z "$BODY" ]; then
    BAD="health_unreachable"
  else
    BAD=$(printf '%s' "$BODY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("unparseable"); raise SystemExit
if d.get("version") != sys.argv[1]: print("version_drift"); raise SystemExit
if d.get("status") not in (None, "ok"): print("status_degraded"); raise SystemExit
if isinstance(d.get("sessions_count"), int) and d["sessions_count"] == 0: print("sessions_zero"); raise SystemExit
print("")
' "$VERSION" 2>/dev/null)
  fi
  if [ -n "$BAD" ]; then
    say "观察窗口内失败：$BAD ⇒ 回滚到 $CURRENT"
    if [ -n "$CURRENT" ]; then
      pm2_restart "$COMMHUB_HOME/runtime-${CURRENT//./-}" || true
      sleep 8
      BACK=$(health_version)
      if [ "$BACK" = "$CURRENT" ]; then
        stage_fail observe_window_failed "观察窗口内 $BAD；**已回滚到 $CURRENT**" 21
      fi
      stage_fail rollback_failed "观察窗口内 $BAD，回滚也没起来（现在是 ${BACK:-读不到}）" 15
    fi
    stage_fail observe_window_failed "观察窗口内 $BAD，且不知道原版本，无法回滚" 21
  fi
done
say "观察窗口通过：${OBSERVE_S}s 内 version/status/sessions 均正常"
# 2026-10-31 —— **哨兵行定型**（外部复核：「version 单独一行标 role，观察时刻单独标 observed」）。
# 一行、字段固定、可 grep：跨 run 比对时不需要人读散文。
#   role=deployment_label —— 这一格是**部署标签**，不是代码指纹（同 /health.version_role）
# 2026-10-31 —— #3177：**这一行原来只有部署标签，没有字节标识**。
# 「同一版本号、不同字节」在部署日志里完全同形（.245 与 .246 就是），而部署记录正是
# 事后要说清「那天上线的是什么」的地方。制品里现在有 build-info.json（prepack 注入），
# 直接读**我们刚装进去的那份**，不依赖 /health 的鉴权投影、也不依赖 git。
BUILD_INFO="$RUNTIME_DIR/node_modules/@sleep2agi/commhub-server/build-info.json"
BUILD_COMMIT="-"; BUILD_DIRTY="-"
if [ -f "$BUILD_INFO" ]; then
  BUILD_COMMIT=$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,40\}\)".*/\1/p' "$BUILD_INFO" | head -1)
  BUILD_DIRTY=$(sed -n 's/.*"dirty"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$BUILD_INFO" | head -1)
  [ -n "$BUILD_COMMIT" ] || BUILD_COMMIT="-"
  [ -n "$BUILD_DIRTY" ] || BUILD_DIRTY="-"
else
  # 没有不等于没问题：老版本制品里没有这个文件，要能看出来「这一格没读到」
  BUILD_COMMIT="absent"
fi
# 2026-10-31 —— #3177：既然制品里有 build-info，就把「**跑起来的那份字节认不认得自己**」变成断言。
# 不做这一步时，我们能确认「装进去的目录对」，但没法确认「进程真的从这份字节起了」——
# 而 .245/.246 那两次恰恰证明了「版本号对」不足以回答这个问题。
if [ "$BUILD_COMMIT" != "absent" ] && [ "$BUILD_COMMIT" != "-" ]; then
  IDENT=$(curl -s --max-time 6 "$HUB_URL/health" | sed -n 's/.*"build_identified"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -1)
  if [ "$IDENT" != "true" ]; then
    stage_fail build_identity_absent "制品里有 build-info.json（commit=${BUILD_COMMIT:0:12}），但 /health 的 build_identified=${IDENT:-<读不到>} —— 进程没有从这份字节起" 22
  fi
  say "构建标识自证：/health build_identified=true（制品 commit=${BUILD_COMMIT:0:12}）"
fi
printf 'DEPLOY v=%s role=%s observed=%s build_commit=%s dirty=%s\n' \
  "$NEWV" "deployment_label" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(printf '%s' "$BUILD_COMMIT" | cut -c1-12)" "$BUILD_DIRTY"
say "回滚命令：HUB_RUNTIME_DIR=$COMMHUB_HOME/runtime-$(printf '%s' "${CURRENT:-}" | tr '.' '-') pm2 restart $PM2_NAME --update-env"
exit 0
