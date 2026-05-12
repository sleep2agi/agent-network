#!/usr/bin/env bash
# agent-only.sh — 在 agent 机器上只起 N 个 agent 节点,连远端 hub.
# 适合把 agent 跟 hub 分离部署: 云服务器跑 hub-only.sh,本机或别的服务器跑 agent-only.sh.
#
# 用法 (root 用户,自动建非 root 用户):
#   curl -fsSL https://anet.sh/agent-only.sh | \
#     ANET_HUB=http://你的云服务器IP:9200 \
#     MINIMAX_KEY=sk-cp-xxxxx \
#     MINIMAX_MODEL=MiniMax-M2.7 \
#     bash -s -- 主编 编辑
#
# 注意 `bash -s --` 不能少:`-s` 让 bash 从 stdin 读脚本,`--` 把后面的当位置参数.
# 不传 alias 会按可用内存自动决定起多少个 (1G->1, 2G->1, 4G->2, 6G->3, 8G+ ->5):
#   curl -fsSL https://anet.sh/agent-only.sh | \
#     ANET_HUB=... MINIMAX_KEY=... bash

set -euo pipefail

ANET_HUB="${ANET_HUB:-}"
MINIMAX_KEY="${MINIMAX_KEY:-}"
MINIMAX_MODEL="${MINIMAX_MODEL:-MiniMax-M2.7}"
USERNAME="${ANET_USER:-anet}"
WIPE="${WIPE:-0}"
HUB_USER="${HUB_USER:-admin}"
HUB_PASS="${HUB_PASS:-anethub}"

if [ -z "$ANET_HUB" ]; then
  echo "[!] ANET_HUB 必填.示例:"
  echo "    ANET_HUB=http://你的云服务器IP:9200 MINIMAX_KEY=sk-cp-xxx ./agent-only.sh"
  exit 1
fi
if [ -z "$MINIMAX_KEY" ]; then
  echo "[!] MINIMAX_KEY 必填."
  exit 1
fi

# === Root: 装基础包 + 建非 root 用户 ===
if [ "$(id -u)" -eq 0 ]; then
  echo "[root] 准备 $USERNAME 用户 + 基础依赖..."
  id "$USERNAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USERNAME"
  apt-get update -qq
  apt-get install -y -qq curl tmux ca-certificates >/dev/null
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  cp "$0" "/home/$USERNAME/agent-only.sh"
  chown "$USERNAME:$USERNAME" "/home/$USERNAME/agent-only.sh"
  chmod +x "/home/$USERNAME/agent-only.sh"
  exec su - "$USERNAME" -c "ANET_HUB='$ANET_HUB' MINIMAX_KEY='$MINIMAX_KEY' MINIMAX_MODEL='$MINIMAX_MODEL' WIPE='$WIPE' HUB_USER='$HUB_USER' HUB_PASS='$HUB_PASS' bash ~/agent-only.sh ${*:-}"
fi

# === 决定要起几个 agent ===
if [ "$#" -gt 0 ]; then
  NODES=("$@")
else
  MEM_GB=$(free -g 2>/dev/null | awk '/^Mem:/{print $2}')
  MEM_GB=${MEM_GB:-4}
  if [ "$MEM_GB" -le 2 ]; then
    NODES=("助手")
    echo "[i] 内存 ${MEM_GB}G,只起 1 个 agent."
  elif [ "$MEM_GB" -le 4 ]; then
    NODES=("主编" "编辑")
  elif [ "$MEM_GB" -le 6 ]; then
    NODES=("主编" "编辑" "审核")
  else
    NODES=("排版发布者" "主编" "信息采集" "编辑" "审核")
  fi
fi

# === 非 root: 安装 + 连 hub + 起 agent ===
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global >/dev/null
grep -q '.npm-global/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
export PATH=~/.npm-global/bin:$PATH

if [ "$WIPE" = "1" ] || [ "$WIPE" = "true" ]; then
  echo "[wipe] 清状态..."
  tmux ls 2>/dev/null | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  pkill -f agent-node 2>/dev/null || true
  rm -rf ~/.anet ~/anodes/.anet ~/.npm/_npx ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
fi

echo "[1/4] 装 anet cli + agent-node (preview)..."
set +e
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node 2>&1
RC=$?
if [ $RC -ne 0 ]; then
  rm -rf ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
  npm i -g @sleep2agi/agent-network @sleep2agi/agent-node 2>&1; RC=$?
fi
set -e
[ $RC -ne 0 ] && { echo "[!] npm install 失败"; exit 1; }

echo "[2/4] 验证 hub 在 $ANET_HUB ..."
HEALTH=$(curl -fs "$ANET_HUB/health" 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  echo "[!] 无法连 $ANET_HUB/health.检查:"
  echo "    1. 云服务器是否运行 hub (curl $ANET_HUB/health 在 hub 那台机器上能通?)"
  echo "    2. 安全组是否开 9200 端口"
  echo "    3. ANET_HUB URL 是否正确"
  exit 1
fi
echo "    Hub OK: $HEALTH" | head -c 200; echo ""

echo "[3/4] 登录 $HUB_USER ..."
mkdir -p ~/anodes && cd ~/anodes
anet login --hub "$ANET_HUB" --username "$HUB_USER" --password "$HUB_PASS"

echo "[4/4] 创建并启动 ${NODES[*]} agent (各自独立 tmux session) ..."
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
for alias in "${NODES[@]}"; do
  if [ ! -f ".anet/nodes/$alias/config.json" ]; then
    echo "  + 创建节点 $alias"
    anet node create "$alias" --runtime claude-agent-sdk \
      --model "$MINIMAX_MODEL" \
      --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
      --env "ANTHROPIC_AUTH_TOKEN=$MINIMAX_KEY" \
      --env "ANTHROPIC_MODEL=$MINIMAX_MODEL" \
      >/dev/null
  fi
  SESS="anet-node-$alias"
  tmux kill-session -t "$SESS" 2>/dev/null || true
  tmux new-session -d -s "$SESS" -n "$alias" "$PATH_PREFIX anet node start \"$alias\"; bash"
  sleep 0.5
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "================================================================"
echo "  ✅ Agent 已启动并连到远端 hub"
echo ""
echo "  Hub:    $ANET_HUB"
echo "  本机:    $LAN_IP"
echo ""
for alias in "${NODES[@]}"; do
  echo "  Agent $alias  →  tmux a -t anet-node-$alias"
done
echo ""
echo "  浏览器访问 hub 那台机器的 Dashboard 应该能看到这些 agent 上线."
echo "  停掉本机所有 agent:  tmux ls | awk -F: '/^anet-node-/{print \$1}' | xargs -I{} tmux kill-session -t {}"
echo "================================================================"
tmux ls
