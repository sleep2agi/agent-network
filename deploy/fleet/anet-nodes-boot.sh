#!/usr/bin/env bash
# 开机把 agent 节点（当前 ~74 节点跨 ~20 project + $HOME/.anet 根注册表）拉回来。
# 由 ~/.config/systemd/user/anet-nodes-boot.service 调用（user 单元 + linger + After=pm2-fleet.service）。
#
# 🔴 版本 v2 · 2026-08-17 · 按通信龙 review 改：
#   - MUST-FIX 1: exit code 反映真实状态（still_missing 或 fail_projects > 0 → exit 1）
#   - MUST-FIX 2: post-flight 用独立 find 枚举，不复用 sweep 的 glob；sweep glob 覆盖 ~/.anet 根注册表
#   - v2.1 (2026-08-17 装前发现): -maxdepth 3 只到 nodes/ 目录本身，漏掉 depth-4 的 project 级节点
#     （只找到根注册表的 10 个）；改 -maxdepth 4 + -not -path '*/.anet/nodes/*/*'（排除节点子目录如 channels/），
#     校验：find 137 = sweep glob 137 完全对齐
#   - v2.2 (2026-08-17 通信龙 review 深挖): 137 目录里 18 个无 config.json（8 个根 grok-cwd 老壳 +
#     3 个当前在 tmux 但无 config 的孤儿：B站开发牛/A站副责人/通信SDK牛 + 6 个更老残留 + 1 个 08-15 有日志
#     的通信牛）。改 sweep 和 post-flight 都以「有 config.json」为判据，避免"永远红"的假绿反面。
#     校验：find config.json 119 = 137 - 18 精确对齐。
#   - v2.3 (2026-08-17 通信龙第四条必改): 全域重名检测。TMCode副责人 有 2 份 config（tmcode=codex-app-server
#     + tmteam=codex-sdk，runtime 不同），sweep 遍历顺序决定哪份生效 → 隐式择一。改为：pre-sweep 建立
#     alias→paths 映射，双份 config 者进 CONFLICT_ALIASES 集，sweep 和 post-flight 都跳过，计入 conflict_count。
#     "本次跳过，不猜哪份生效" —— 让人显式决策，别让脚本静默选边。
#   - v2.4 (2026-08-18 首跑后 root cause 分类): 首跑 exit 1 · still_missing=23，通信龙实测发现 16 意外红分 3 类：
#     A 假红/late-green（sweep 12s 窗口 < 45s auto-confirm 窗口）· B dev-channels 卡框（PR #901 修，走正门）·
#     C 老 runtime / 缺 token 从未跑过。两处收窄：
#     (1) 分母收窄到有 config.json 且 config.token 非空
#     (2) 每轮 project up 完成后 sleep 30s grace 再 post-flight → 覆盖 45s auto-confirm 窗口
#   - v2.5 (2026-08-18 通信龙又发现松判据): v2.4 的 token 存在检查漏了 token TYPE。评估m马 有 token 但是 utok_
#     （用户 token），而 SSE 需要 ntok_（节点 token）→ 仍然起不来。**"存在 ≠ 可用"** 又一次踩坑。
#     判据收紧到三条件：(a) 有 config.json (b) runtime ∈ 支持集 (c) token 以 ntok_ 开头。校验 110 精确对上（119-9）。
#     排除 9 个：I站牛/书生课程牛/课程测试1号/课程测试马/A站牛/通信运营马（无 token）+ I站工程马/I站运营马
#     （runtime=claude-code 已退役）+ 评估m马（utok_ 而非 ntok_）。**anet doctor --fix 能修但需要 Vincent 决定，不动。**
#   - MUST-FIX 3: hub 用 /health 而不是 TCP listen 探测
#   - Q1: PROJECT_TIMEOUT 按节点数动态算（60 + 25*n），tmteam 22 节点 → 610s
#   - Q2: 整轮重试最多 2 轮（幂等保底），不做 per-project 退避
#   - Q3: SKIP_PROJECTS 默认空；非空必 log 出跳过谁 + 跳过节点数
#
# 🔴 幂等设计（照抄 pm2-fleet-boot）：per-alias 用 `tmux has-session -t "=<alias>"` 精确判活。
#    `=` 不能省：本机 `A站内容` 会前缀命中 `A站内容牛`。
#
# 🔴 用 `anet project up` 而不是 `anet node start`：preview.39 单节点入口有 exit 0 + "✅" 但节点没起的 bug
#    （PR #895 已修但未发布）；`project up` 走 verifyNodeUp 真实校验。
#
# 🔴 二层依赖一层：hub /health OK 才继续（systemd After=pm2-fleet.service + 脚本自检双保险）。

set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"
ANET="$(command -v anet)"
TMUX="$(command -v tmux)"

STAGGER="${STAGGER:-3}"                        # 节点间 & project 间 delay
HUB_PORT="${HUB_PORT:-9200}"
MAX_ROUNDS="${MAX_ROUNDS:-2}"                  # 整轮重试最多次数（幂等保底）
SKIP_PROJECTS="${SKIP_PROJECTS:-}"             # 逗号分隔，如 "agent-network-dashboard,dsh-project"

log() { echo "[anet-nodes-boot $(date '+%F %T')] $*"; }

[ -z "$ANET" ] && { log "🔴 anet 不在 PATH（PATH=$PATH）"; exit 2; }
[ -z "$TMUX" ] && { log "🔴 tmux 不在 PATH"; exit 2; }

# 一层依赖：hub /health 语义级检查（端口 listen 不代表能用）
HEALTH_RAW=$(curl -fsS --max-time 5 "http://127.0.0.1:$HUB_PORT/health" 2>&1) || {
  log "🔴 hub /health 请求失败：$(echo "$HEALTH_RAW" | head -c 200)"
  exit 3
}
if ! echo "$HEALTH_RAW" | grep -q '"ok":true'; then
  log "🔴 hub /health 返回非 ok: $(echo "$HEALTH_RAW" | head -c 200)"
  exit 3
fi
log "hub /health OK · anet=$ANET · max_rounds=$MAX_ROUNDS · stagger=${STAGGER}s"

# --- 收集 sweep 覆盖面（含 ~/.anet 根注册表）---
declare -a ANET_DIRS
shopt -s nullglob
for d in $HOME/*/.anet; do
  [ -d "$d/nodes" ] && ANET_DIRS+=("$d")
done
# 根注册表：$HOME/*/.anet 匹配不到 $HOME/.anet（* 不匹配空）
[ -d $HOME/.anet/nodes ] && ANET_DIRS+=("$HOME/.anet")
log "sweep 覆盖：${#ANET_DIRS[@]} 个 .anet 注册表（含 ~/.anet 根注册表若存在）"

# --- SKIP_PROJECTS 展开 + 显式 log（默认空；非空必报告）---
declare -A SKIP_MAP
if [ -n "$SKIP_PROJECTS" ]; then
  IFS=',' read -ra SKIP_ARR <<< "$SKIP_PROJECTS"
  skip_node_count=0
  for skp in "${SKIP_ARR[@]}"; do
    skp="${skp// /}"
    [ -z "$skp" ] && continue
    SKIP_MAP["$skp"]=1
    # 计算跳过节点数（诚实报"少扫了多少"）
    for cand in "$HOME/$skp/.anet/nodes" "$HOME/.anet/nodes"; do
      # 根注册表 ~/.anet 的 project 标签就是家目录的 basename（原脚本这里写死
      # 了那台机的用户名 —— 路径参数化之后它就成了唯一残留的机器耦合点）。
      [ "$skp" = "$(basename "$HOME")" ] && [ "$cand" = "$HOME/.anet/nodes" ] || \
        [ "$cand" = "$HOME/$skp/.anet/nodes" ] || continue
      [ -d "$cand" ] && skip_node_count=$((skip_node_count + $(ls "$cand" 2>/dev/null | wc -l)))
    done
  done
  log "🟡 跳过 project (显式 SKIP_PROJECTS): $SKIP_PROJECTS · 共 $skip_node_count 节点未纳入本次 sweep"
fi

# --- v2.5 pre-sweep: 3 条件过滤 + 重名冲突检测 ---
# v2.5: 分母 = (a) 有 config.json + (b) runtime ∈ 支持集 + (c) token 以 ntok_ 开头 = 110 节点
#       松判据（v2.4 只查 token 存在）会漏 utok_ 陷阱：评估m马 有 token 但是 utok_ 而非 ntok_，SSE 起不来。
# 支持的 runtime 集从 anet CLI 报错信息取得（当前 preview.39 严格 normalizer 接受这 7 个）
OK_RUNTIMES="claude-agent-sdk claude-code-cli codex-sdk codex-app-server grok-build-acp grok-build-cli opencode-cli"
declare -A ALIAS_PATHS      # 3 条件全过的可启动节点：alias → paths (| 分隔)
declare -A SKIP_NODES_MAP   # 3 条件之一未过：alias → 排除原因（不算缺，从 sweep + post-flight 排除）
while IFS= read -r cfg; do
  nd="$(dirname "$cfg")"
  al="$(basename "$nd")"
  reason=$(python3 - "$cfg" "$OK_RUNTIMES" <<'PY'
import json, sys
cfg, ok_str = sys.argv[1], sys.argv[2]
OK = set(ok_str.split())
try:
    d = json.load(open(cfg))
except Exception as e:
    print(f'parse_err:{e}'); sys.exit(0)
rt = d.get('runtime', '?'); t = d.get('token') or ''
reasons = []
if rt not in OK: reasons.append(f"runtime={rt!r}")
if not t: reasons.append("no_token")
elif not t.startswith('ntok_'): reasons.append(f"token={t[:5]}...")
print(' + '.join(reasons))
PY
)
  if [ -z "$reason" ]; then
    ALIAS_PATHS["$al"]="${ALIAS_PATHS[$al]:+${ALIAS_PATHS[$al]}|}$nd"
  else
    SKIP_NODES_MAP["$al"]="$reason"
  fi
done < <(find $HOME -maxdepth 5 -path '*/.anet/nodes/*/config.json' -type f 2>/dev/null)

# 计 config 条数（TMCode副责人 有 2 份都通过 3 条件，config 计 2，unique alias 计 1）
_total_valid_configs=0
for _al in "${!ALIAS_PATHS[@]}"; do
  IFS='|' read -ra _parr <<< "${ALIAS_PATHS[$_al]}"
  _total_valid_configs=$((_total_valid_configs + ${#_parr[@]}))
done
log "分母校验（3 条件：有 config + runtime ∈ 支持集 + token=ntok_）：config 条数 = $_total_valid_configs（期望 110）· 唯一 alias = ${#ALIAS_PATHS[@]}（TMCode副责人 2份都过 3 条件 → 差 1 来自这里）"
if [ "${#SKIP_NODES_MAP[@]}" -gt 0 ]; then
  log "🟡 跳过 ${#SKIP_NODES_MAP[@]} 个配置不达 3 条件的节点（不算缺）："
  for al in "${!SKIP_NODES_MAP[@]}"; do
    log "    · $al  ← ${SKIP_NODES_MAP[$al]}"
  done
fi

declare -A CONFLICT_ALIASES
conflict_count=0
for al in "${!ALIAS_PATHS[@]}"; do
  paths="${ALIAS_PATHS[$al]}"
  if [[ "$paths" == *"|"* ]]; then
    CONFLICT_ALIASES["$al"]=1
    conflict_count=$((conflict_count+1))
    log "🔴 重名冲突: '$al' 同时存在于 ${paths//|/ 和 } —— 两份都有 config，本次跳过（不猜哪份生效）"
  fi
done
if [ "$conflict_count" -eq 0 ]; then
  log "重名冲突检测: 0 (all clear)"
else
  log "🔴 重名冲突总数: $conflict_count（每个计入 fail，人工决策哪份权威后再跑）"
fi

# --- sweep 循环（含整轮重试）---
still_missing=0
fail_projects=0

for ((round=1; round<=MAX_ROUNDS; round++)); do
  log "=== round $round/$MAX_ROUNDS ==="
  round_up=0; round_skip=0; round_fail=0
  fail_projects=0  # 每轮清零

  for anet_dir in "${ANET_DIRS[@]}"; do
    proj="$(dirname "$anet_dir")"
    proj_name="$(basename "$proj")"

    if [ -n "${SKIP_MAP[$proj_name]:-}" ]; then
      log "  $proj_name: 显式跳过（SKIP_PROJECTS）"
      continue
    fi

    aliases=()
    shell_only=()
    skip_nodes_in_proj=()
    conflict_in_proj=()
    for nd in "$anet_dir/nodes/"*/; do
      [ -d "$nd" ] || continue
      al="$(basename "$nd")"
      if [ ! -f "$nd/config.json" ]; then
        shell_only+=("$al")
        continue
      fi
      if [ -n "${SKIP_NODES_MAP[$al]:-}" ]; then
        skip_nodes_in_proj+=("$al")
        continue
      fi
      if [ -n "${CONFLICT_ALIASES[$al]:-}" ]; then
        conflict_in_proj+=("$al")
        continue
      fi
      aliases+=("$al")
    done
    if [ "${#skip_nodes_in_proj[@]}" -gt 0 ] && [ "$round" -eq 1 ]; then
      log "  $proj_name: 3 条件未过的节点 ${#skip_nodes_in_proj[@]} 个 → 跳过（不算缺）: ${skip_nodes_in_proj[*]}"
    fi
    if [ "${#conflict_in_proj[@]}" -gt 0 ] && [ "$round" -eq 1 ]; then
      log "  $proj_name: 重名冲突节点 ${#conflict_in_proj[@]} 个 → 跳过（已在 pre-sweep 记 fail）: ${conflict_in_proj[*]}"
    fi
    if [ "${#shell_only[@]}" -gt 0 ] && [ "$round" -eq 1 ]; then
      log "  $proj_name: 无 config.json 的空壳目录 ${#shell_only[@]} 个 → 跳过（不算缺）: ${shell_only[*]:0:5}"
    fi
    [ "${#aliases[@]}" -eq 0 ] && continue

    missing=()
    for al in "${aliases[@]}"; do
      "$TMUX" has-session -t "=$al" 2>/dev/null || missing+=("$al")
    done

    if [ "${#missing[@]}" -eq 0 ]; then
      log "  $proj_name: ${#aliases[@]} 节点全部在 tmux → skip"
      round_skip=$((round_skip+1)); continue
    fi

    # PROJECT_TIMEOUT 按节点数动态算（Q1 采纳：60 + 25 * n）
    PROJECT_TIMEOUT=$(( 60 + 25 * ${#aliases[@]} ))
    first5="${missing[*]:0:5}"; more=""
    [ "${#missing[@]}" -gt 5 ] && more=" (+$((${#missing[@]}-5)) more)"
    log "  $proj_name: 缺 ${#missing[@]}/${#aliases[@]} → project up · timeout=${PROJECT_TIMEOUT}s · 缺: $first5$more"

    if ( cd "$proj" && timeout "$PROJECT_TIMEOUT" "$ANET" project up --stagger "$STAGGER" 2>&1 \
          | sed "s|^|      [$proj_name] |" ); then
      round_up=$((round_up+1))
    else
      round_fail=$((round_fail+1))
      fail_projects=$((fail_projects+1))
      log "  🔴 $proj_name: project up 失败/超时（${PROJECT_TIMEOUT}s）—— 继续下一 project"
    fi
    sleep "$STAGGER"
  done

  log "round $round 结果：up=$round_up skip=$round_skip fail=$round_fail"

  # --- v2.4 late-green grace: project up 完成后 sleep 30s 让 dev-channels 45s 自动应答窗口有机会关闭 ---
  log "round $round: 30s late-green grace（覆盖 auto-confirm 45s 窗口，防止提前采样成假红）"
  sleep 30

  # --- post-flight 用独立 find 枚举（MUST-FIX 2：不复用 sweep 的 glob）---
  still_missing=0
  missing_examples=()
  while IFS= read -r cfg; do
    nd="$(dirname "$cfg")"
    al="$(basename "$nd")"
    # skip 名单也从 post-flight 剔除，避免"我明说要跳的又被算成缺"
    proj_of_node="$(basename "$(dirname "$(dirname "$nd")")")"
    [ -n "${SKIP_MAP[$proj_of_node]:-}" ] && continue
    # v2.3 重名冲突节点已在 conflict_count 计过，post-flight 不重复算
    [ -n "${CONFLICT_ALIASES[$al]:-}" ] && continue
    # v2.5 3 条件未过的节点从分母排除（不算缺）
    [ -n "${SKIP_NODES_MAP[$al]:-}" ] && continue
    if ! "$TMUX" has-session -t "=$al" 2>/dev/null; then
      still_missing=$((still_missing+1))
      [ "${#missing_examples[@]}" -lt 8 ] && missing_examples+=("$al")
    fi
  done < <(find $HOME -maxdepth 5 -path '*/.anet/nodes/*/config.json' -type f 2>/dev/null)

  log "round $round post-flight（独立 find 枚举）：still_missing=$still_missing"
  [ "$still_missing" -gt 0 ] && log "  缺失示例（前 8）：${missing_examples[*]}"

  if [ "$still_missing" -eq 0 ] && [ "$fail_projects" -eq 0 ]; then
    log "round $round 已全达成，跳出重试"
    break
  fi
  if [ "$round" -lt "$MAX_ROUNDS" ]; then
    log "round $round 有缺口，进入 round $((round+1))（幂等会跳过已起节点）"
    sleep "$STAGGER"
  fi
done

# --- MUST-FIX 1 + v2.3: 退出码反映真实状态（含 conflict） ---
if [ "$still_missing" -gt 0 ] || [ "$fail_projects" -gt 0 ] || [ "$conflict_count" -gt 0 ]; then
  log "🔴 sweep 未达成：still_missing=$still_missing fail_projects=$fail_projects conflict=$conflict_count → exit 1"
  exit 1
fi
log "✅ sweep 达成（$MAX_ROUNDS 轮内全部节点在 tmux，无重名冲突）"
exit 0
