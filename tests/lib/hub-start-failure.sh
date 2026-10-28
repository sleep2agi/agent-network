#!/usr/bin/env bash
# #2867 —— hub 起不来时，把「取包/安装/启动链」与「hub 自身不健康」分开标注。
#
# 起因（2026-10-28 两次 PR 门变红）：
#   FAIL: hub did not answer /health within 180s
#   Hub version: @sleep2agi/commhub-server@0.9.0-preview.186 [source: registry]
#   Resolving dependencies
#   ❌ Server failed to start. Check the bunx output above for the real error.
# 这是**每次现场从 npm registry 拉包**，registry 一抖整个分片就红，而红的样子和
# 「业务断言失败」完全一样，看的人没法分辨，只能整条 25 分钟重跑。
#
# 这里只做**标注**，不改判定：两种情况都仍然 exit 1（不拿「跳过」去换安静）。
classify_hub_start_failure() {
  local log="${1:-/tmp/hub.log}"
  local text=""
  [ -f "$log" ] && text="$(tail -100 "$log" 2>/dev/null || true)"
  if printf '%s' "$text" | grep -qiE 'Server failed to start|Check the bunx output|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|npm error|failed to download|404 Not Found - GET'; then
    printf 'INFRA_FAIL: hub_from_registry_unavailable — 取包/安装/启动链失败（registry 侧），不是业务断言失败\n'
    return 1
  fi
  printf 'FAIL: hub_start_unhealthy — 包已就位但 hub 未通过 /health（可能是 hub 自身缺陷）\n'
  return 0
}
