#!/usr/bin/env bash
# 一键安装 + 启动 Agent Network (Ubuntu/Debian)
#
# 在 root 上跑会自动建 anet 用户切过去,然后:
#   1. 装 nodejs 22 + tmux (agent-node preview.9+ 要求 node >= 22.13)
#   2. npm i -g @sleep2agi/agent-network @sleep2agi/agent-node
#   3. tmux session "anet" 内启动: hub + dashboard + N 个 agent
#
# 用法:
#   curl -fsSL https://anet.sh/setup-anet.sh -o setup-anet.sh
#   chmod +x setup-anet.sh
#   MINIMAX_KEY=sk-cp-xxxxx ./setup-anet.sh                       # 默认 5 个节点
#   MINIMAX_KEY=sk-cp-xxxxx ./setup-anet.sh 节点A 节点B 节点C       # 自定义节点列表
#
# 之后:
#   tmux a -t anet                # 进入查看所有 window
#   tmux kill-session -t anet     # 关闭整网

set -euo pipefail

MINIMAX_KEY="${MINIMAX_KEY:-}"
# MiniMax Anthropic-compatible 网关支持的模型 (官方文档):
#   MiniMax-M2.7, MiniMax-M2.7-highspeed,
#   MiniMax-M2.5, MiniMax-M2.5-highspeed,
#   MiniMax-M2.1, MiniMax-M2.1-highspeed, MiniMax-M2
# 默认 MiniMax-M2.7 (最新); 可用 MINIMAX_MODEL=MiniMax-M2 ./setup-anet.sh 覆盖
MINIMAX_MODEL="${MINIMAX_MODEL:-MiniMax-M2.7}"
USERNAME="${ANET_USER:-anet}"
HUB_IP="${ANET_HUB_IP:-0.0.0.0}"
# WIPE=1 — 启动前清光所有状态:tmux session / ~/.anet / ~/.commhub / npx cache
# 适合每次都从干净环境重跑测试.默认关闭(增量启动).
WIPE="${WIPE:-0}"

# 默认节点列表
if [ "$#" -gt 0 ]; then
  NODES=("$@")
else
  NODES=("排版发布者" "主编" "信息采集" "编辑" "审核")
fi

wipe_state() {
  echo "[wipe] 杀光 anet-* tmux session..."
  tmux ls 2>/dev/null | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
  echo "[wipe] 杀光 commhub-server / agent-network-dashboard / agent-node 进程..."
  pkill -f commhub-server 2>/dev/null || true
  pkill -f agent-network-dashboard 2>/dev/null || true
  pkill -f agent-node 2>/dev/null || true
  echo "[wipe] 删 ~/.anet ~/.commhub ~/.npm/_npx ~/anodes/.anet ..."
  rm -rf ~/.anet ~/.commhub ~/.npm/_npx ~/anodes/.anet 2>/dev/null || true
  # npm-global 的 @sleep2agi 包有时半安装遗留 dir 导致下次 npm i 报 ENOTEMPTY,
  # WIPE 模式下顺手清掉.
  echo "[wipe] 删 ~/.npm-global/lib/node_modules/@sleep2agi/ ..."
  rm -rf ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null || true
  echo "[wipe] 完成。"
}

# === 1. 在 root 上时:建非 root 用户,装基础包,然后切过去重新执行 ===
if [ "$(id -u)" -eq 0 ]; then
  echo "[1/5] root 检测到 — 准备 $USERNAME 用户 + 系统依赖..."
  id "$USERNAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USERNAME"
  apt-get update -qq
  apt-get install -y -qq curl tmux ca-certificates unzip >/dev/null
  # agent-network preview.9+ engines require Node >= 22.13. Older Node
  # makes npm refuse install with a misleading EBADENGINE — install 22 LTS.
  NODE_NEEDS_INSTALL=0
  if ! command -v node >/dev/null 2>&1; then
    NODE_NEEDS_INSTALL=1
  else
    NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$NODE_MAJOR" -lt 22 ]; then NODE_NEEDS_INSTALL=1; fi
  fi
  if [ "$NODE_NEEDS_INSTALL" = "1" ]; then
    echo "[1/5] 装 Node.js 22 LTS (agent-node preview.9+ 要求) ..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  fi
  # Bun is required by commhub-server (TypeScript source with bun shebang).
  # Install system-wide so both root and the anet user can use it.
  if ! command -v bun >/dev/null 2>&1; then
    echo "[1/5] 装 Bun (commhub-server 需要) ..."
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
    if [ -x "$HOME/.bun/bin/bun" ]; then
      cp "$HOME/.bun/bin/bun" /usr/local/bin/bun
      chmod +x /usr/local/bin/bun
    fi
  fi
  cp "$0" "/home/$USERNAME/setup-anet.sh"
  chmod +x "/home/$USERNAME/setup-anet.sh"
  chown "$USERNAME:$USERNAME" "/home/$USERNAME/setup-anet.sh"
  echo "[1/5] 切到 $USERNAME 用户继续 ..."
  exec su - "$USERNAME" -c "MINIMAX_KEY='$MINIMAX_KEY' MINIMAX_MODEL='$MINIMAX_MODEL' ANET_HUB_IP='$HUB_IP' WIPE='$WIPE' bash ~/setup-anet.sh ${NODES[*]}"
fi

# === 以下以非 root 用户执行 ===

if [ "$WIPE" = "1" ] || [ "$WIPE" = "true" ]; then
  wipe_state
fi

if [ -z "$MINIMAX_KEY" ]; then
  echo "[!] MINIMAX_KEY 环境变量未设置。"
  echo "    运行: MINIMAX_KEY=sk-cp-xxxxx ./setup-anet.sh"
  exit 1
fi

cd ~

# === 2. npm 全局到 ~/.npm-global (避免 root 权限) ===
echo "[2/5] 装 anet cli + agent-node 到 ~/.npm-global ..."
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global >/dev/null
grep -q '.npm-global/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
export PATH=~/.npm-global/bin:$PATH
# Don't silence — npm 错误必须暴露,之前 --silent | tail -5 把失败信息吞了
# 用 set +e 包一下,失败的话不让 pipefail 直接退出整个脚本
set +e
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node 2>&1
NPM_RC=$?
# ENOTEMPTY recovery: a prior half-finished npm install can leave the
# package dir behind; npm's atomic rename then fails. Wipe the offending
# scope dir and retry once.
if [ $NPM_RC -ne 0 ]; then
  echo "[2/5] 检测到 npm install 失败,清理半装残留并重试..."
  rm -rf ~/.npm-global/lib/node_modules/@sleep2agi 2>/dev/null
  npm i -g @sleep2agi/agent-network @sleep2agi/agent-node 2>&1
  NPM_RC=$?
fi
set -e
if [ $NPM_RC -ne 0 ]; then
  echo ""
  echo "[!] npm install 失败 (exit $NPM_RC)。可能原因:"
  echo "    - 网络问题: 试试 npm config set registry https://registry.npmmirror.com"
  echo "    - 权限问题: 确认 ~/.npm-global 可写"
  echo "    - 单独装试试: npm i -g @sleep2agi/agent-network"
  exit 1
fi
# 验证 anet 在 PATH 里
if ! command -v anet >/dev/null 2>&1; then
  echo "[!] anet 命令找不到,~/.npm-global/bin 没在 PATH 里。"
  echo "    试试: export PATH=~/.npm-global/bin:\$PATH; anet -v"
  exit 1
fi
anet -v | head -1

# 每个进程独立 tmux session,方便独立 attach/restart 不干扰别人
PATH_PREFIX="PATH=~/.npm-global/bin:\$PATH"
kill_session() { tmux kill-session -t "$1" 2>/dev/null || true; }

# === 3. 启动 hub (独立 tmux session: anet-hub) ===
mkdir -p ~/anodes && cd ~/anodes
echo "[3/5] 启动 hub (tmux session: anet-hub) ..."
kill_session anet-hub
tmux new-session -d -s anet-hub -n hub "$PATH_PREFIX anet hub start --ip $HUB_IP; bash"

# 等 hub 健康
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:9200/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 等默认账户 admin/anethub 可登录 — anet hub start 在 /health OK 之后才异步
# register default account, 需要再给它几秒钟. 这里直接轮询 login API.
echo "[3/5] 等默认账户就绪 ..."
LOGIN_OK=0
for i in $(seq 1 30); do
  RES=$(curl -s -X POST http://127.0.0.1:9200/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"anethub"}' 2>/dev/null || true)
  if echo "$RES" | grep -q '"ok":true'; then
    LOGIN_OK=1
    break
  fi
  sleep 1
done
if [ "$LOGIN_OK" -ne 1 ]; then
  echo "[!] admin/anethub 登录始终失败. anet-hub 那个 tmux session 里看看 hub 启动有没有报错:"
  echo "    tmux a -t anet-hub"
  exit 1
fi

# 登录 (cli 全局态写入 ~/.anet/config.json)
echo "[3/5] 登录 admin/anethub ..."
anet login --hub http://127.0.0.1:9200 --username admin --password anethub

# === 4. 启动 dashboard (独立 tmux session: anet-dashboard) ===
echo "[4/5] 启动 dashboard (tmux session: anet-dashboard) ..."
kill_session anet-dashboard
tmux new-session -d -s anet-dashboard -n dashboard "$PATH_PREFIX anet hub dashboard --ip $HUB_IP; bash"

# === 5. 每个 agent 独立 tmux session: anet-node-<alias> ===
echo "[5/5] 创建并启动 ${NODES[*]} ..."
for alias in "${NODES[@]}"; do
  if [ ! -f ".anet/nodes/$alias/config.json" ]; then
    echo "  + 创建节点 $alias"
    anet node create "$alias" --runtime claude-agent-sdk \
      --model "$MINIMAX_MODEL" \
      --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
      --env "ANTHROPIC_AUTH_TOKEN=$MINIMAX_KEY" \
      --env "ANTHROPIC_MODEL=$MINIMAX_MODEL" \
      >/dev/null
  else
    echo "  - 节点 $alias 已存在,跳过创建"
  fi
  SESS="anet-node-$alias"
  kill_session "$SESS"
  tmux new-session -d -s "$SESS" -n "$alias" "$PATH_PREFIX anet node start \"$alias\"; bash"
  sleep 0.5
done

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "================================================================"
echo "  ✅ Agent Network 已启动 (每个进程一个独立 tmux session)"
echo ""
echo "  Hub:        http://$LAN_IP:9200    (tmux session: anet-hub)"
echo "  Dashboard:  http://$LAN_IP:3000    (tmux session: anet-dashboard)  admin/anethub"
echo ""
for alias in "${NODES[@]}"; do
  echo "  Agent $alias  →  tmux a -t anet-node-$alias"
done
echo ""
echo "  查看所有 sessions:    tmux ls"
echo "  attach 某个进程:      tmux a -t anet-hub | anet-dashboard | anet-node-<alias>"
echo "  detach:               Ctrl-b d"
echo "  停掉某个:             tmux kill-session -t anet-node-<alias>"
echo "  停掉所有 anet-*:      tmux ls | awk -F: '/^anet-/{print \$1}' | xargs -I{} tmux kill-session -t {}"
echo "================================================================"
echo "  机器重启后一键恢复 (#117):"
echo "    cd ~/anodes && anet project up"
echo "  升级到最新 (channel-aware, #88):"
echo "    anet upgrade                   # 当前 channel"
echo "    anet upgrade --channel preview # 切 preview"
echo "  Claude session 绑定 (#115):"
echo "    anet node create <alias> --resume <session-id>"
echo "    anet node create <alias> --resume-latest"
echo "================================================================"
tmux ls
