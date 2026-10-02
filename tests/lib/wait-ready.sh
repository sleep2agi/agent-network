#!/usr/bin/env bash
# wait-ready.sh —— 等一个刚起的服务就绪,代替「固定 sleep N 再查一次」(#479)。
#
#   wait_http_ready <url> [timeout_s=30] [log_file]
#
# 每 250 ms 请求一次 <url>,拿到 2xx 就返回 0;超时返回 1,并把 log_file 的最后 40 行打到 stderr。
# 只等,不判:调用方原来那一行检查(比如 grep '"ok":true')照旧跟在后面,断言不变 ——
#   wait_http_ready "http://127.0.0.1:9211/health" 30 /tmp/hub.log || true
#   curl -s http://127.0.0.1:9211/health | grep -q '"ok":true' && pass … || fail …
# 不用管道:就绪判据是 curl 自己的退出码,在 set -euo pipefail 的脚本里也不会把「就绪」判成「没就绪」
# (见 CLAUDE.md 复核纪律 ②)。
wait_http_ready() {
  local url="$1" timeout="${2:-30}" log="${3:-}"
  local deadline=$(( $(date +%s) + timeout ))
  while :; do
    if curl -sf -o /dev/null --max-time 2 "$url" 2>/dev/null; then return 0; fi
    if (( $(date +%s) >= deadline )); then break; fi
    sleep 0.25
  done
  echo "wait_http_ready: $url not ready after ${timeout}s" >&2
  if [[ -n "$log" && -f "$log" ]]; then
    echo "--- last 40 lines of $log ---" >&2
    tail -40 "$log" >&2 || true
  fi
  return 1
}
