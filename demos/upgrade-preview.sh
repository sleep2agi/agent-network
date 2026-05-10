#!/usr/bin/env bash
# 一键升级到 preview 测试 SSE-driven chat (dashboard 0.2.0 / cli 2.0.3-preview.0)
#
# 在已经跑过 setup-anet.sh 的服务器上跑:
#   curl -fsSL https://anet.sh/upgrade-preview.sh | bash
#
# 它做这些事:
# 1. 升级 anet cli 到 preview tag (拉新的 PINNED_DASHBOARD_VERSION)
# 2. 关掉当前 anet-dashboard tmux session
# 3. 清 npx 缓存让 dashboard 拉到 preview 版本
# 4. 重启 dashboard 在原来的 tmux session 里
#
# Hub 和 agent 不动 — 只换 cli + dashboard.

set -euo pipefail

# 必须用非 root 用户跑 (跟 setup-anet.sh 一样的权限模型)
if [ "$(id -u)" -eq 0 ]; then
  echo "[!] 当前是 root,请切到 anet 用户:  su - anet"
  echo "    然后再跑这条命令。"
  exit 1
fi

# 确保 npm-global 在 PATH
export PATH=~/.npm-global/bin:$PATH

echo "[1/4] 升级 anet cli 到 preview ..."
npm i -g @sleep2agi/agent-network@preview --silent 2>&1 | tail -3
anet -v | head -1

echo ""
echo "[2/4] 关掉 dashboard tmux session ..."
tmux kill-session -t anet-dashboard 2>/dev/null || true

echo ""
echo "[3/4] 清 npx 缓存 (让 dashboard 拉到 preview 版) ..."
rm -rf ~/.npm/_npx

echo ""
echo "[4/4] 重启 dashboard ..."
HUB_IP="${ANET_HUB_IP:-0.0.0.0}"
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
tmux new-session -d -s anet-dashboard -n dashboard "$PATH_PREFIX anet hub dashboard --ip $HUB_IP; bash"

# 给它 8 秒拉包 + 启动
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000 -o /dev/null 2>&1; then break; fi
  sleep 1
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "================================================================"
echo "  ✅ Dashboard preview 已启动"
echo "  访问:  http://$LAN_IP:3000   (admin / anethub)"
echo ""
echo "  改了什么:"
echo "    - chat 从 HTTP 轮询改成 SSE-driven"
echo "    - agent 回复 1 秒内推到 UI,不再延迟 2-30 秒"
echo "    - 服务器轮询压力降到接近 0"
echo ""
echo "  浏览器记得 Cmd+Shift+R 强刷一次清缓存 JS"
echo "  查看实时日志:    tmux a -t anet-dashboard"
echo "================================================================"
