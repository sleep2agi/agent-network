#!/usr/bin/env bash
# curl 退出码 → **分层**的一句话。给探针/验收脚本用。
#
# 2026-10-31 —— 起因（TMA客户端欧 的分层表）：
#   把 `curl ... || fail "cannot read"` 写成一句，等于把所有失败层压成同一句话：
#     TLS 层就断 / TLS 通了但 HTTP 没人读 / 请求被读了但应用层没回 / 读了但挂住
#   这四层的第一嫌疑对象完全不同（证书 / 代理网关 WAF / 应用 / 负载），
#   而 `|| fail` 之后它们只剩「连不上」。
#
# 口径（照抄那张表，**单列**，不并进「传输层失败」）：
#   400            探针不合规 —— 不算读数（是我们的 curl 写错了）
#   401/403        到了应用层，被鉴权/白名单挡下
#   404            到了应用层，路由/参数不对
#   35/60          TLS 层就断（握手 / 证书）
#   6/7            DNS / 连接建立失败 —— 请求没到应用层
#   56             传输层通了，HTTP 没人读（RST）⇒ 第一怀疑代理/网关/WAF
#   52             请求被读了，但没应答就被关 ⇒ 有服务端在处理
#   28             连接开着但没回 ⇒ 读到了，挂住（不是「没通」）
#   其它           贴原文，不要翻译
#
# 用法：
#   . "$(dirname "$0")/lib/curl-exit.sh"
#   if ! out=$(curl -sS "$url"); then rc=$?; curl_fail "读取 $url" "$rc" >&2; exit 1; fi
#
# 自检：bash scripts/lib/curl-exit.sh --selftest

curl_layer() {
  case "$1" in
    0)   echo "成功";;
    400) echo "探针不合规 ⇒ **不算读数**（先修 curl 参数，别当成故障）";;
    401) echo "应用层：未鉴权";;
    403) echo "应用层：Origin/IP 白名单";;
    404) echo "应用层：路由或参数不存在";;
    35)  echo "TLS 层：握手失败";;
    60)  echo "TLS 层：证书校验失败";;
    6)   echo "DNS：解析失败 ⇒ 请求没到应用层";;
    7)   echo "连接：建立失败 ⇒ 请求没到应用层";;
    # 2026-10-31 —— 实测（外部复核：八个监听器 × 三种形状 × curl 7.61.1 / Node 24）：
    #   52 与 56 的分界**不是「读没读」**，而是「关得够不够早」：
    #     从不读的服务器 + 1MB 积压未读 ⇒ 仍是 52
    #     accept 后**立刻** destroy        ⇒ 56
    #   ⇒ 所以 56 只说明「连接被很早地关掉」，不说明「HTTP 没人读」。
    56)  echo "连接很早就被关掉（accept 后立刻 destroy 的典型读数）⇒ 第一怀疑代理/网关/WAF；**不能据此断言「HTTP 没人读」**（实测：从不读的服务器同样给 52）";;
    52)  echo "请求被读过或尚未读，连接被关且没有应答 ⇒ **不能据此区分「读了没回」与「根本没读」**（实测：1MB 积压未读也是 52）；要区分得看服务端日志";;
    # 2026-10-31 —— 28 **不是终态**，是「加大 --max-time 再跑一次」的提示。
    #   28 @ -m 8 之后用 -m 30 重跑同一条：
    #     变成 401/403/404 ⇒ 只是慢（服务端在处理）
    #     仍是 28         ⇒ N 翻近 4 倍仍无响应 ⇒ 才算不可判
    #   ⇒ 两个读数必须**分开记**（28@8s / 28@30s），否则差值丢了，
    #     也会把冷启动 / 首次 TLS / 慢查询误记成「卡住」。
    # 2026-10-31 —— 28 是**观测者产生的码**：不设 --max-time 就拿不到它。
    #   实测：连接阶段一个字节都没发，同样返回 28 ⇒ 它不等于「对方收到了却不回」。
    28)  echo "**超时（这个码由观测者产生：不设 --max-time 不会出现）**⇒ 既可能是连接没建立，也可能是读了不回；**加大 --max-time 重跑一次再判**（两次都 28 才算卡住，两个读数分开记）";;
    101) echo "真正升级（WS）；带 Accept 校验才算安全项";;
    *)   echo "未分类退出码 ⇒ 贴原文，不要翻译";;
  esac
}

curl_fail() {
  # $1 = 在做什么（人话），$2 = curl 的退出码
  printf '✗ %s —— curl rc=%s：%s\n' "$1" "${2:-?}" "$(curl_layer "${2:-?}")"
}

_selftest() {
  local bad=0
  local ran=0
  local expect=8
  # witness 用：临时把 expect 改坏
  check() { # name, rc, 期望包含
    ran=$((ran+1))
    local got; got="$(curl_layer "$2")"
    if [[ "$got" == *"$3"* ]]; then
      printf '✓ selftest %s: rc=%s ⇒ %s\n' "$1" "$2" "$got"
    else
      printf '✗ selftest %s: rc=%s 期望包含「%s」，实际「%s」\n' "$1" "$2" "$3" "$got" >&2
      bad=1
    fi
  }
  check "TLS 层"        60 "TLS"
  check "DNS 层"        6  "DNS"
  check "HTTP 没人读"   56 "没人读"
  check "52 不能区分读没读" 52 "不能据此区分"
  check "28 由观测者产生" 28 "观测者产生"
  check "28 不是终态"   28 "重跑"
  check "探针自身错"    400 "不算读数"
  check "未分类"        9  "贴原文"
  # 2026-10-31 —— 用例数也要钉：遍历 0 个用例同样会「通过」。
  if [ "$ran" -ne "$expect" ]; then
    echo "✗ selftest 用例数应为 $expect，实际 $ran" >&2
    return 1
  fi
  if [ "$bad" -eq 0 ]; then
    echo "✓ selftest $ran 例全部符合预期（含 1 个必须分类失败的负例：rc=9）"
  fi
  return "$bad"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --selftest) _selftest; exit $?;;
    "") echo "用法：source 本文件后调用 curl_fail；或 bash $0 --selftest"; exit 2;;
    *) curl_layer "$1";;
  esac
fi
