#!/bin/bash
# A100 InternStudio 一键配置脚本
# 在网页终端粘贴执行即可
# 配置 VL牛(InternVL-U) + SVG牛(InternSVG) 两个 Codex session

set -e
COMMHUB_URL="http://47.77.216.1:9200"

echo "========== 1. 环境检查 =========="
echo "OS: $(uname -a)"
echo "GPU:"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "  no GPU detected"
echo "Disk: $(df -h / | tail -1)"
echo "RAM: $(free -h | awk 'NR==2{print $2}')"
echo "Node: $(node --version 2>/dev/null || echo 'not installed')"
echo "npm: $(npm --version 2>/dev/null || echo 'not installed')"
echo "tmux: $(tmux -V 2>/dev/null || echo 'not installed')"
echo "codex: $(which codex 2>/dev/null || echo 'not installed')"
echo ""

echo "========== 2. 安装依赖 =========="
# Node.js (if missing)
if ! command -v node &>/dev/null; then
  echo "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# tmux (if missing)
if ! command -v tmux &>/dev/null; then
  echo "Installing tmux..."
  apt-get update && apt-get install -y tmux
fi

echo "Node: $(node --version)"
echo "npm: $(npm --version)"
echo "tmux: $(tmux -V)"
echo ""

echo "========== 3. 安装 Codex =========="
if ! command -v codex &>/dev/null; then
  echo "Installing Codex CLI..."
  npm install -g @openai/codex
fi
echo "Codex: $(codex --version 2>/dev/null || echo 'installed')"
echo ""

echo "========== 4. 配置 CommHub MCP =========="
# Codex 用 ~/.codex/config.json 配 MCP
mkdir -p ~/.codex
cat > ~/.codex/config.json << 'MCPEOF'
{
  "mcpServers": {
    "commhub": {
      "type": "http",
      "url": "http://47.77.216.1:9200/mcp"
    }
  }
}
MCPEOF
echo "CommHub MCP config written to ~/.codex/config.json"
echo ""

echo "========== 5. 测试 CommHub 连通性 =========="
curl -s --max-time 5 "$COMMHUB_URL/health" | python3 -m json.tool 2>/dev/null || echo "WARNING: CommHub unreachable at $COMMHUB_URL"
echo ""

echo "========== 6. 创建项目目录 =========="
mkdir -p ~/internvl-u ~/internsvg
echo "Created ~/internvl-u ~/internsvg"
echo ""

echo "========== 7. Clone InternSVG =========="
if [ ! -d ~/internsvg/InternSVG ]; then
  cd ~/internsvg && git clone https://github.com/hmwang2002/InternSVG.git
  echo "InternSVG cloned"
else
  echo "InternSVG already exists, skipping"
fi
echo ""

echo "========== 8. 创建 tmux sessions =========="
# VL牛
tmux kill-session -t vl-codex 2>/dev/null || true
tmux new-session -d -s vl-codex -c ~/internvl-u
echo "Created tmux:vl-codex (~/internvl-u)"

# SVG牛
tmux kill-session -t svg-codex 2>/dev/null || true
tmux new-session -d -s svg-codex -c ~/internsvg
echo "Created tmux:svg-codex (~/internsvg)"
echo ""

echo "========== 9. 启动 Codex sessions =========="
# VL牛
tmux send-keys -t vl-codex "COMMHUB_URL=$COMMHUB_URL COMMHUB_ALIAS=VL牛 codex --dangerously-bypass-approvals-and-sandbox" Enter
echo "Started VL牛 in tmux:vl-codex"

# SVG牛
tmux send-keys -t svg-codex "COMMHUB_URL=$COMMHUB_URL COMMHUB_ALIAS=SVG牛 codex --dangerously-bypass-approvals-and-sandbox" Enter
echo "Started SVG牛 in tmux:svg-codex"
echo ""

echo "========== 10. 启动 SSE Poller =========="
# 下载 poller 脚本
mkdir -p ~/poller
curl -sL "https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/poller/commhub-sse-poller.sh" -o ~/poller/commhub-sse-poller.sh
chmod +x ~/poller/commhub-sse-poller.sh

# 停掉旧 poller
pkill -f "commhub-sse-poller" 2>/dev/null || true
sleep 1

# VL牛 Poller
nohup ~/poller/commhub-sse-poller.sh \
  --alias "VL牛" --tmux vl-codex \
  --url "$COMMHUB_URL" \
  > /tmp/sse-poller-vl.log 2>&1 &
echo "SSE Poller started for VL牛 (PID: $!)"

# SVG牛 Poller
nohup ~/poller/commhub-sse-poller.sh \
  --alias "SVG牛" --tmux svg-codex \
  --url "$COMMHUB_URL" \
  > /tmp/sse-poller-svg.log 2>&1 &
echo "SSE Poller started for SVG牛 (PID: $!)"
echo ""

echo "========== 完成！ =========="
echo ""
echo "检查状态："
echo "  tmux ls"
echo "  tmux attach -t vl-codex   # 看 VL牛"
echo "  tmux attach -t svg-codex  # 看 SVG牛"
echo "  tail -f /tmp/sse-poller-vl.log   # Poller 日志"
echo "  tail -f /tmp/sse-poller-svg.log  # Poller 日志"
echo ""
echo "tmux sessions:"
tmux ls
