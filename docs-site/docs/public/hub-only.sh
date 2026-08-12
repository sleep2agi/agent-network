#!/usr/bin/env bash
# hub-only.sh — 一键起 Hub (+ 可选 Dashboard / 指挥室) 在云服务器上.
#
# 自动做的事:
#   1. 建 anet 用户 (非 root) + sudoers NOPASSWD
#   2. 加 4G swap (永久) + swappiness=20  (防 OOM)
#   3. 装 bun / node / npm / curl / tmux
#   4. tmux session 启 hub / dashboard / 指挥室 (默认; 重启服务器后要手动再跑一次)
#   5. AUTOSTART=1 改用 systemd --user + enable-linger 自启 (重启不丢)
#
# 用法 (root 跑):
#   # 只 hub
#   curl -fsSL https://anet.sh/hub-only.sh | bash
#
#   # hub + dashboard
#   curl -fsSL https://anet.sh/hub-only.sh | bash
#
#   # hub + dashboard + 指挥室 agent
#   curl -fsSL https://anet.sh/hub-only.sh | MINIMAX_KEY=sk-cp-xxx bash
#
#   # 不要 dashboard, 只 hub + 指挥室
#   curl -fsSL https://anet.sh/hub-only.sh | NO_DASHBOARD=1 MINIMAX_KEY=sk-cp-xxx bash
#
#   # 想自启 (重启服务器自动拉): 加 AUTOSTART=1
#   curl -fsSL https://anet.sh/hub-only.sh | AUTOSTART=1 MINIMAX_KEY=sk-cp-xxx bash
#
#   # 清状态重来: 加 WIPE=1 (删 ~/.anet ~/.commhub + 杀进程)
#   curl -fsSL https://anet.sh/hub-only.sh | WIPE=1 MINIMAX_KEY=sk-cp-xxx bash
#
# 安全组要开: 22 (SSH), 9200 (Hub), 3000 (Dashboard, 可选)

set -euo pipefail

USERNAME="${ANET_USER:-anet}"
HUB_IP="${ANET_HUB_IP:-127.0.0.1}"   # 默认只 bind 本机 (安全). 想公网: ANET_HUB_IP=0.0.0.0 必须先改密 + 反代 + TLS
WIPE="${WIPE:-0}"
NO_DASHBOARD="${NO_DASHBOARD:-0}"
AUTOSTART="${AUTOSTART:-0}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-4}"
MINIMAX_KEY="${MINIMAX_KEY:-}"
MINIMAX_MODEL="${MINIMAX_MODEL:-MiniMax-M2.7}"
COMMANDER_ALIAS="${COMMANDER_ALIAS:-指挥室}"
COMMANDER_RUNTIME="${COMMANDER_RUNTIME:-http}"  # http (~80MB) | claude-agent-sdk (~600MB)

# === Root 阶段: 系统级配置 + 切非 root 用户 ===
if [ "$(id -u)" -eq 0 ]; then
  echo "[root 1/4] 建 $USERNAME 用户 (不给 sudo, 安全默认)..."
  id "$USERNAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USERNAME"
  # anet 用户跑 hub / dashboard / agent / systemd --user / tmux 都不需要 sudo,
  # 所以默认不给 NOPASSWD sudo (R6 安全风险). 升级 npm 包用 ~/.npm-global, 重启服务用 systemd --user.
  # 已经存在的 sudoers.d/$USERNAME (老脚本残留) 一并清掉.
  rm -f "/etc/sudoers.d/$USERNAME" 2>/dev/null || true

  echo "[root 2/4] 加 ${SWAP_SIZE_GB}G swap (防 OOM)..."
  if ! swapon --show 2>/dev/null | grep -q '/swapfile'; then
    if fallocate -l "${SWAP_SIZE_GB}G" /swapfile 2>/dev/null; then :; else
      dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB*1024)) status=none
    fi
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl -w vm.swappiness=20 >/dev/null
    grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=20' >> /etc/sysctl.conf
  else
    echo "  (swap 已存在, 跳过)"
  fi

  echo "[root 3/4] 装基础包 (curl/tmux/node/bun)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates unzip tmux >/dev/null
  # agent-network preview.9+ engines require Node >= 22.13. Install 22 LTS
  # if Node is missing or older than 22 (NodeSource setup_22.x handles both).
  NODE_NEEDS_INSTALL=0
  if ! command -v node >/dev/null 2>&1; then
    NODE_NEEDS_INSTALL=1
  else
    NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    [ "$NODE_MAJOR" -lt 22 ] && NODE_NEEDS_INSTALL=1
  fi
  if [ "$NODE_NEEDS_INSTALL" = "1" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  if ! command -v bun >/dev/null 2>&1; then
    su - "$USERNAME" -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null 2>&1 || true
    USER_BUN="/home/$USERNAME/.bun/bin/bun"
    [ -x "$USER_BUN" ] && cp "$USER_BUN" /usr/local/bin/bun && chmod +x /usr/local/bin/bun
  fi

  # `|| true` 是有意的:非 root 用户装 bun 允许失败,不该让整个安装中止。
  # 但**失败后保持沉默不是有意的** —— 上面这步已经知道 bun 在不在,
  # 却什么都不说,脚本继续往下并宣告安装完成。用户要等到
  # `anet hub start` 才会撞上 "requires the Bun runtime"。
  # commhub-server 是 bun-only,所以这里必须明说,并给出可执行的补救。
  if ! command -v bun >/dev/null 2>&1; then
    echo ""
    echo "  [!] Bun 未能自动安装 —— commhub-server 是 bun-only,"
    echo "      在装上之前 'anet hub start' 不会成功。"
    echo "      补救(任选其一):"
    echo "        npm i -g bun"
    echo "        或按 https://bun.sh/docs/installation 安装后重跑本脚本"
    echo ""
  fi

  if [ "$AUTOSTART" = "1" ] || [ "$AUTOSTART" = "true" ]; then
    echo "[root 4/4] enable-linger ($USERNAME systemd 不依赖登录)..."
    loginctl enable-linger "$USERNAME"
  else
    echo "[root 4/4] 跳过自启 (默认 tmux 模式; 加 AUTOSTART=1 启用 systemd)"
  fi

  cp "$0" "/home/$USERNAME/hub-only.sh"
  chown "$USERNAME:$USERNAME" "/home/$USERNAME/hub-only.sh"
  chmod +x "/home/$USERNAME/hub-only.sh"
  echo "[root] 切到 $USERNAME 继续..."
  exec su - "$USERNAME" -c "ANET_HUB_IP='$HUB_IP' WIPE='$WIPE' NO_DASHBOARD='$NO_DASHBOARD' AUTOSTART='$AUTOSTART' MINIMAX_KEY='$MINIMAX_KEY' MINIMAX_MODEL='$MINIMAX_MODEL' COMMANDER_ALIAS='$COMMANDER_ALIAS' COMMANDER_RUNTIME='$COMMANDER_RUNTIME' bash ~/hub-only.sh"
fi

# === 非 root (anet) 阶段 ===
mkdir -p ~/.npm-global ~/.commhub
npm config set prefix ~/.npm-global >/dev/null 2>&1
grep -q '.npm-global/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
export PATH=~/.npm-global/bin:$PATH

if [ "$WIPE" = "1" ] || [ "$WIPE" = "true" ]; then
  echo "[wipe] 清状态..."
  systemctl --user stop anet-hub anet-dashboard anet-commander 2>/dev/null || true
  systemctl --user disable anet-hub anet-dashboard anet-commander 2>/dev/null || true
  rm -f ~/.config/systemd/user/anet-hub.service \
        ~/.config/systemd/user/anet-dashboard.service \
        ~/.config/systemd/user/anet-commander.service 2>/dev/null
  tmux ls 2>/dev/null | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  pkill -9 -u "$(id -u)" -f commhub-server 2>/dev/null || true
  pkill -9 -u "$(id -u)" -f agent-network-dashboard 2>/dev/null || true
  pkill -9 -u "$(id -u)" -f agent-node 2>/dev/null || true
  rm -rf ~/.anet ~/.commhub ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
  mkdir -p ~/.commhub
fi

echo "[1/4] 装 anet cli + agent-node (npm preview)..."
set +e
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node >/dev/null 2>&1
RC=$?
if [ $RC -ne 0 ]; then
  rm -rf ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
  npm i -g @sleep2agi/agent-network @sleep2agi/agent-node >/dev/null 2>&1
  RC=$?
fi
set -e
[ $RC -ne 0 ] && { echo "[!] npm install 失败"; exit 1; }

PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"

# helper: 启服务 (tmux 默认; AUTOSTART=1 用 systemd --user)
launch_service() {
  local name="$1" desc="$2" cmd="$3" workdir="${4:-$HOME}"
  if [ "$AUTOSTART" = "1" ] || [ "$AUTOSTART" = "true" ]; then
    mkdir -p ~/.config/systemd/user
    cat > "$HOME/.config/systemd/user/$name.service" <<UNIT
[Unit]
Description=$desc
After=network.target

[Service]
Type=simple
WorkingDirectory=$workdir
ExecStart=/bin/bash -lc "$cmd"
Restart=always
RestartSec=5
StandardOutput=append:%h/.commhub/$name.log
StandardError=append:%h/.commhub/$name.log
Environment=PATH=$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user reset-failed "$name" 2>/dev/null || true
    systemctl --user enable --now "$name.service" >/dev/null
  else
    tmux kill-session -t "$name" 2>/dev/null || true
    tmux new-session -d -s "$name" -c "$workdir" "$PATH_PREFIX $cmd; bash"
  fi
}

echo "[2/4] 启 hub..."
launch_service "anet-hub" "CommHub Server" "anet hub start --ip $HUB_IP"

for i in $(seq 1 30); do
  curl -fs http://127.0.0.1:9200/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fs http://127.0.0.1:9200/health >/dev/null 2>&1 \
  || { echo "[!] hub 起不来"; tail -30 ~/.commhub/anet-hub.log 2>/dev/null; exit 1; }
echo "      ✓ hub 已就绪"

# 等默认 admin 账户初始化
for i in $(seq 1 20); do
  curl -fs -X POST http://127.0.0.1:9200/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"anethub"}' 2>/dev/null \
    | grep -q '"ok":true' && break
  sleep 1
done

if [ "$NO_DASHBOARD" != "1" ] && [ "$NO_DASHBOARD" != "true" ]; then
  echo "[3/4] 启 dashboard..."
  launch_service "anet-dashboard" "Agent Network Dashboard" "anet hub dashboard --ip $HUB_IP"
  for i in $(seq 1 30); do
    curl -fs http://127.0.0.1:3000 -o /dev/null && break
    sleep 1
  done
  echo "      ✓ dashboard 启动 (可能还在编译)"
else
  echo "[3/4] 跳过 dashboard (NO_DASHBOARD=1)"
fi

COMMANDER_STARTED=0
if [ -n "$MINIMAX_KEY" ]; then
  echo "[4/4] 启 ${COMMANDER_ALIAS} agent (runtime=$COMMANDER_RUNTIME)..."
  mkdir -p ~/anodes && cd ~/anodes
  anet login --hub "http://127.0.0.1:9200" --username admin --password anethub >/dev/null 2>&1
  if [ ! -f ".anet/nodes/$COMMANDER_ALIAS/config.json" ]; then
    anet node create "$COMMANDER_ALIAS" --runtime "$COMMANDER_RUNTIME" \
      --model "$MINIMAX_MODEL" \
      --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
      --env "ANTHROPIC_AUTH_TOKEN=$MINIMAX_KEY" \
      --env "ANTHROPIC_MODEL=$MINIMAX_MODEL" >/dev/null
  fi
  launch_service "anet-commander" "Commander Agent ($COMMANDER_ALIAS)" \
    "anet node start \"$COMMANDER_ALIAS\"" "$HOME/anodes"
  COMMANDER_STARTED=1
  echo "      ✓ ${COMMANDER_ALIAS} 启动"
else
  echo "[4/4] 跳过指挥室 (没传 MINIMAX_KEY)"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PUB_IP="$(curl -s -m 3 ifconfig.me 2>/dev/null || echo $LAN_IP)"
MODE_TAG="tmux"
[ "$AUTOSTART" = "1" ] || [ "$AUTOSTART" = "true" ] && MODE_TAG="systemd --user (重启自动拉)"
echo ""
echo "================================================================"
if [ "$COMMANDER_STARTED" = "1" ]; then
  echo "  ✅ Hub + Dashboard + ${COMMANDER_ALIAS}(${COMMANDER_RUNTIME}) 已启动 [$MODE_TAG]"
elif [ "$NO_DASHBOARD" = "1" ]; then
  echo "  ✅ Hub 已启动 [$MODE_TAG]"
else
  echo "  ✅ Hub + Dashboard 已启动 [$MODE_TAG]"
fi
echo ""
if [ "$HUB_IP" = "0.0.0.0" ]; then
  echo "  ⚠️  公网模式 (绑 0.0.0.0) — 立刻做这三件事:"
  echo "     1. anet login --username admin --password anethub  → 然后 anet passwd 改密"
  echo "     2. 安全组只放给受信 IP / 走反代 + TLS (Caddy/Nginx)"
  echo "     3. 不要把 dashboard / tmux 接口直接挂公网"
  echo ""
  echo "  Hub:        http://$PUB_IP:9200      内网: http://$LAN_IP:9200"
  [ "$NO_DASHBOARD" != "1" ] && \
  echo "  Dashboard:  http://$PUB_IP:3000      内网: http://$LAN_IP:3000"
else
  echo "  🔒 本机模式 (绑 $HUB_IP) — 默认安全, 只本地能访问"
  echo "     想跨服务器组网, 设 ANET_HUB_IP=0.0.0.0 重跑 (公网前先改密 + 反代 + TLS)"
  echo ""
  echo "  Hub:        http://127.0.0.1:9200"
  [ "$NO_DASHBOARD" != "1" ] && \
  echo "  Dashboard:  http://127.0.0.1:3000"
fi
echo "  默认账户:    admin / anethub  ⚠️  立刻 \`anet passwd\` 改密 (尤其公网部署)"
echo ""
if [ "$AUTOSTART" = "1" ] || [ "$AUTOSTART" = "true" ]; then
  echo "  systemd 管理:"
  echo "    systemctl --user status  anet-hub"
  echo "    systemctl --user restart anet-hub"
  echo "    journalctl --user -u anet-hub -f"
else
  echo "  tmux 管理 (重启服务器会丢, 想自启加 AUTOSTART=1 重跑一次脚本):"
  echo "    tmux ls                            # 看会话"
  echo "    tmux a -t anet-hub                 # 接入 (Ctrl+B,D 退出不杀)"
  echo "    tmux kill-session -t anet-hub      # 停"
fi
echo ""
echo "  其他机器加 agent (5 个角色):"
echo "    curl -fsSL https://anet.sh/agent-only.sh | \\"
echo "      ANET_HUB=http://$PUB_IP:9200 \\"
echo "      MINIMAX_KEY=sk-cp-... \\"
echo "      bash -s -- 主编 编辑 审核 信息采集 排版发布者"
echo ""
echo "  云服务器安全组别忘了开 9200$([ "$NO_DASHBOARD" != "1" ] && echo " + 3000") 端口."
echo ""
echo "  升级 (channel-aware, #88): anet upgrade   /  anet upgrade --channel preview"
echo "================================================================"
free -h | head -2
echo
if [ "$AUTOSTART" = "1" ] || [ "$AUTOSTART" = "true" ]; then
  systemctl --user --no-pager list-units 'anet-*' 2>/dev/null | head -10
else
  tmux ls 2>/dev/null
fi
