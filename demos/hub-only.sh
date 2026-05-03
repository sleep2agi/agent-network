#!/usr/bin/env bash
# hub-only.sh — 云服务器上跑 Hub + Dashboard + 1 个"指挥室" agent.
#
# 适合 2G 小内存 VM 当中央通信节点;其他 agent 用 agent-only.sh 在别的机器上启动.
#
# 用法 (root 用户):
#   # 不带 MINIMAX_KEY: 只起 hub + dashboard,不起 agent
#   curl -fsSL https://anet.vansin.me/hub-only.sh | bash
#
#   # 带 MINIMAX_KEY: 同时起一个 "指挥室" agent 在本机
#   curl -fsSL https://anet.vansin.me/hub-only.sh | MINIMAX_KEY=sk-cp-xxx bash
#
# 默认绑定 0.0.0.0 让 LAN 客户端可达.云服务器需要开 9200 + 3000 端口.

set -euo pipefail

USERNAME="${ANET_USER:-anet}"
HUB_IP="${ANET_HUB_IP:-0.0.0.0}"
WIPE="${WIPE:-0}"
MINIMAX_KEY="${MINIMAX_KEY:-}"
MINIMAX_MODEL="${MINIMAX_MODEL:-MiniMax-M2.7}"
COMMANDER_ALIAS="${COMMANDER_ALIAS:-指挥室}"

# === Root: 装基础包 + 建非 root 用户 ===
if [ "$(id -u)" -eq 0 ]; then
  echo "[root] 准备 $USERNAME 用户 + 基础依赖..."
  id "$USERNAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USERNAME"
  apt-get update -qq
  apt-get install -y -qq curl tmux ca-certificates unzip >/dev/null
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
    [ -x "$HOME/.bun/bin/bun" ] && cp "$HOME/.bun/bin/bun" /usr/local/bin/bun && chmod +x /usr/local/bin/bun
  fi
  cp "$0" "/home/$USERNAME/hub-only.sh"
  chown "$USERNAME:$USERNAME" "/home/$USERNAME/hub-only.sh"
  chmod +x "/home/$USERNAME/hub-only.sh"
  exec su - "$USERNAME" -c "ANET_HUB_IP='$HUB_IP' WIPE='$WIPE' MINIMAX_KEY='$MINIMAX_KEY' MINIMAX_MODEL='$MINIMAX_MODEL' COMMANDER_ALIAS='$COMMANDER_ALIAS' bash ~/hub-only.sh"
fi

# === 非 root: 安装 + 启动 ===
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global >/dev/null
grep -q '.npm-global/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
export PATH=~/.npm-global/bin:$PATH

if [ "$WIPE" = "1" ] || [ "$WIPE" = "true" ]; then
  echo "[wipe] 清状态..."
  tmux ls 2>/dev/null | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  pkill -f commhub-server 2>/dev/null || true
  pkill -f agent-network-dashboard 2>/dev/null || true
  rm -rf ~/.anet ~/.commhub ~/.npm/_npx ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
fi

echo "[1/3] 装 anet cli + agent-node (preview)..."
# 即使不起 agent 也装 agent-node 以备后续手动启动用.
set +e
npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview 2>&1
RC=$?
if [ $RC -ne 0 ]; then
  rm -rf ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
  npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview 2>&1; RC=$?
fi
set -e
[ $RC -ne 0 ] && { echo "[!] npm install 失败"; exit 1; }

echo "[2/3] 启动 hub + dashboard 在独立 tmux session..."
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
tmux kill-session -t anet-hub 2>/dev/null || true
tmux kill-session -t anet-dashboard 2>/dev/null || true
tmux new-session -d -s anet-hub -n hub "$PATH_PREFIX anet hub start --ip $HUB_IP; bash"
for i in $(seq 1 30); do
  curl -fs http://127.0.0.1:9200/health >/dev/null 2>&1 && break
  sleep 1
done

# 等默认账户就绪
for i in $(seq 1 30); do
  RES=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"anethub"}' 2>/dev/null || true)
  echo "$RES" | grep -q '"ok":true' && break
  sleep 1
done

tmux new-session -d -s anet-dashboard -n dashboard "$PATH_PREFIX anet hub dashboard --ip $HUB_IP; bash"

# === [3/3] 起一个 "指挥室" agent (有 MINIMAX_KEY 才起) ===
COMMANDER_STARTED=0
if [ -n "$MINIMAX_KEY" ]; then
  echo "[3/3] 起 ${COMMANDER_ALIAS} agent (本机) ..."
  mkdir -p ~/anodes && cd ~/anodes
  anet login --hub "http://127.0.0.1:9200" --username admin --password anethub
  if [ ! -f ".anet/nodes/$COMMANDER_ALIAS/config.json" ]; then
    anet node create "$COMMANDER_ALIAS" --runtime claude-agent-sdk \
      --model "$MINIMAX_MODEL" \
      --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
      --env "ANTHROPIC_AUTH_TOKEN=$MINIMAX_KEY" \
      --env "ANTHROPIC_MODEL=$MINIMAX_MODEL" \
      >/dev/null
  fi
  SESS="anet-node-$COMMANDER_ALIAS"
  tmux kill-session -t "$SESS" 2>/dev/null || true
  tmux new-session -d -s "$SESS" -n "$COMMANDER_ALIAS" "$PATH_PREFIX anet node start \"$COMMANDER_ALIAS\"; bash"
  COMMANDER_STARTED=1
else
  echo "[3/3] 跳过 agent 启动 (没传 MINIMAX_KEY).hub + dashboard 完成."
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PUB_IP="$(curl -s -m 3 ifconfig.me 2>/dev/null || echo $LAN_IP)"
echo ""
echo "================================================================"
if [ "$COMMANDER_STARTED" = "1" ]; then
  echo "  ✅ Hub + Dashboard + ${COMMANDER_ALIAS} agent 已启动"
else
  echo "  ✅ Hub + Dashboard 已启动 (无 agent)"
fi
echo ""
echo "  Hub:        http://$PUB_IP:9200      内网: http://$LAN_IP:9200"
echo "  Dashboard:  http://$PUB_IP:3000      内网: http://$LAN_IP:3000"
echo "  默认账户:    admin / anethub"
echo ""
echo "  其他机器上加 agent (用 agent-only.sh):"
echo "    curl -fsSL https://anet.vansin.me/agent-only.sh | \\"
echo "      ANET_HUB=http://$PUB_IP:9200 \\"
echo "      MINIMAX_KEY=sk-cp-... \\"
echo "      bash 主编 编辑"
echo ""
echo "  云服务器安全组别忘了开 9200 + 3000 端口."
echo "================================================================"
tmux ls
