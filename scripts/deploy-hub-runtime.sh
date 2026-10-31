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

health_version() {
  local body
  body=$(curl -s --max-time 6 "$HUB_URL/health" 2>/dev/null) || return 1
  printf '%s' "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('version',''))" 2>/dev/null
}

if [ "${SELFTEST:-0}" = "1" ]; then
  # 只自检「stage 枚举是封闭且互不相同」这条契约 —— 真装/真切换不适合在自检里跑。
  fails=0
  codes="10 11 12 13 14 15 16"
  n=$(printf '%s\n' $codes | sort -u | wc -l | tr -d ' ')
  [ "$n" = "7" ] && echo "✓ selftest stage 退出码 7 个且互不相同" || { echo "✗ stage 退出码有重复"; fails=$((fails+1)); }
  for s in registry_missing install_failed install_version_mismatch health_unreachable health_version_mismatch rollback_failed home_not_found; do
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

# ④ 切换
HUB_RUNTIME_DIR="$RUNTIME_DIR" pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1
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
    HUB_RUNTIME_DIR="$COMMHUB_HOME/runtime-${CURRENT//./-}" pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1
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
    HUB_RUNTIME_DIR="$COMMHUB_HOME/runtime-${CURRENT//./-}" pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1
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
say "回滚命令：HUB_RUNTIME_DIR=$COMMHUB_HOME/runtime-$(printf '%s' "${CURRENT:-}" | tr '.' '-') pm2 restart $PM2_NAME --update-env"
exit 0
