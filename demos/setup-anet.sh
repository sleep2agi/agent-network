#!/usr/bin/env bash
# 一键安装 + 启动 Agent Network (Ubuntu/Debian)
#
# 在 root 上跑会自动建 anet 用户切过去,然后:
#   1. 装 nodejs 20 + tmux
#   2. npm i -g @sleep2agi/agent-network @sleep2agi/agent-node
#   3. tmux session "anet" 内启动: hub + dashboard + N 个 agent
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/sleep2agi/agent-network/main/demos/setup-anet.sh -o setup-anet.sh
#   chmod +x setup-anet.sh
#   MINIMAX_KEY=sk-cp-xxxxx ./setup-anet.sh                       # 默认 5 个节点
#   MINIMAX_KEY=sk-cp-xxxxx ./setup-anet.sh 节点A 节点B 节点C       # 自定义节点列表
#
# 之后:
#   tmux a -t anet                # 进入查看所有 window
#   tmux kill-session -t anet     # 关闭整网

set -euo pipefail

MINIMAX_KEY="${MINIMAX_KEY:-}"
USERNAME="${ANET_USER:-anet}"
HUB_IP="${ANET_HUB_IP:-0.0.0.0}"

# 默认节点列表
if [ "$#" -gt 0 ]; then
  NODES=("$@")
else
  NODES=("排版发布者" "主编" "信息采集" "编辑" "审核")
fi

# === 1. 在 root 上时:建非 root 用户,装基础包,然后切过去重新执行 ===
if [ "$(id -u)" -eq 0 ]; then
  echo "[1/5] root 检测到 — 准备 $USERNAME 用户 + 系统依赖..."
  id "$USERNAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USERNAME"
  apt-get update -qq
  apt-get install -y -qq curl tmux ca-certificates >/dev/null
  if ! command -v node >/dev/null 2>&1; then
    echo "[1/5] 装 Node.js 20 LTS ..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  cp "$0" "/home/$USERNAME/setup-anet.sh"
  chmod +x "/home/$USERNAME/setup-anet.sh"
  chown "$USERNAME:$USERNAME" "/home/$USERNAME/setup-anet.sh"
  echo "[1/5] 切到 $USERNAME 用户继续 ..."
  exec su - "$USERNAME" -c "MINIMAX_KEY='$MINIMAX_KEY' ANTHROPIC_HUB_IP='$HUB_IP' bash ~/setup-anet.sh ${NODES[*]}"
fi

# === 以下以非 root 用户执行 ===

if [ -z "$MINIMAX_KEY" ]; then
  echo "[!] MINIMAX_KEY 环境变量未设置。"
  echo "    运行: MINIMAX_KEY=sk-cp-xxxxx ./setup-anet.sh"
  exit 1
fi

cd ~

# === 2. npm 全局到 ~/.npm-global (避免 root 权限) ===
echo "[2/5] 装 anet cli + agent-node 到 ~/.npm-global ..."
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
grep -q '.npm-global/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
export PATH=~/.npm-global/bin:$PATH
npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview --silent 2>&1 | tail -5

# === 3. 启动 hub (tmux window 0) ===
mkdir -p ~/anodes && cd ~/anodes
echo "[3/5] 启动 hub (tmux session: anet) ..."
tmux kill-session -t anet 2>/dev/null || true
tmux new-session -d -s anet -n hub "PATH=~/.npm-global/bin:\$PATH anet hub start --ip $HUB_IP; bash"

# 等 hub 健康
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:9200/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 登录 (cli 全局态写入 ~/.anet/config.json)
echo "[3/5] 登录 admin/anethub ..."
anet login --hub http://127.0.0.1:9200 --username admin --password anethub

# === 4. 启动 dashboard (tmux window 1) ===
echo "[4/5] 启动 dashboard ..."
tmux new-window -t anet -n dashboard "PATH=~/.npm-global/bin:\$PATH anet hub dashboard --ip $HUB_IP; bash"

# === 5. 创建 + 启动 N 个 agent (跳过 picker,用 --env 直注 MiniMax) ===
echo "[5/5] 创建并启动 ${NODES[*]} ..."
for alias in "${NODES[@]}"; do
  if [ ! -f ".anet/nodes/$alias/config.json" ]; then
    echo "  + 创建节点 $alias"
    anet node create "$alias" --runtime claude-agent-sdk \
      --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
      --env "ANTHROPIC_AUTH_TOKEN=$MINIMAX_KEY" \
      --env "ANTHROPIC_MODEL=MiniMax-M2" \
      >/dev/null
  else
    echo "  - 节点 $alias 已存在,跳过创建"
  fi
  tmux new-window -t anet -n "$alias" "PATH=~/.npm-global/bin:\$PATH anet node start \"$alias\"; bash"
  sleep 0.5
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "================================================================"
echo "  ✅ Agent Network 已启动 (tmux session: anet)"
echo ""
echo "  Hub:        http://$LAN_IP:9200"
echo "  Dashboard:  http://$LAN_IP:3000   (admin / anethub)"
echo ""
echo "  查看运行状态:   tmux a -t anet"
echo "  关闭整个网络:   tmux kill-session -t anet"
echo "================================================================"
tmux list-windows -t anet
