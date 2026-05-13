#!/bin/bash
# Science Team agent entrypoint — reads config from environment variables
#
# Required env:
#   ALIAS              研究Leader | 研究员1号 | 研究员2号 | ...
#   ROLE               leader | researcher
#   TEAM_SIZE          5 / 10 / 20 (used in roster + leader prompt)
#   RESEARCH_TOPIC     综述方向 (e.g. "全面 AI 综述")
#   ANTHROPIC_AUTH_TOKEN  书生 (Intern) API key
#
# Optional env:
#   RUNTIME            default: claude-agent-sdk
#   MODEL              default: intern-s1-pro
#   ANTHROPIC_BASE_URL default: https://chat.intern-ai.org.cn
#   COMMHUB_URL        default: http://server:9200
#
# Phase 1 scope (issue #51):
#   - leader: 简单 round-robin / echo 分派 (Phase 2 RFC-008 实现智能 fan-out)
#   - researcher: 收 task → 简单产出 markdown 子主题段落 → reply

set -eu

ALIAS="${ALIAS:-researcher}"
ROLE="${ROLE:-researcher}"
RUNTIME="${RUNTIME:-claude-agent-sdk}"
MODEL="${MODEL:-intern-s1-pro}"
HUB="${COMMHUB_URL:-http://server:9200}"
TOKEN="${COMMHUB_TOKEN:-}"
TEAM_SIZE="${TEAM_SIZE:-5}"
TOPIC="${RESEARCH_TOPIC:-全面 AI 综述}"

# Prefer ntok_ from shared volume (seeded by seed container)
if [ -f /shared/ntok ]; then
  NTOK="$(cat /shared/ntok)"
  if [ -n "$NTOK" ]; then
    TOKEN="$NTOK"
    echo "  using ntok_ from /shared/ntok"
  fi
fi

# Build roster dynamically: Leader + (TEAM_SIZE - 1) researchers
ROSTER="网络成员 (CommHub alias)：
- 研究Leader (军团 leader)"
i=1
LAST=$((TEAM_SIZE - 1))
while [ "$i" -le "$LAST" ]; do
  ROSTER="$ROSTER
- 研究员${i}号"
  i=$((i + 1))
done

# Role-specific system prompt
if [ "$ROLE" = "leader" ]; then
  PROMPT="你是科研军团 *研究Leader*，统筹 ${TEAM_SIZE} 人团队产出关于「${TOPIC}」的综述。

Phase 1 当前实现（占位）：
- 收到 task 后，简单将子主题 round-robin 分派给研究员1号 - 研究员${LAST}号
- 等所有研究员 reply 后，简单拼接结果作为 final output
- *不做*智能 fan-out / 子主题切分 / 引用 dedup（Phase 2 RFC-008 规划）

$ROSTER

通信方式 (MCP tools)：
- commhub_get_all_status() → 查在线研究员
- commhub_send_task(alias, task) → 分派子任务
- commhub_reply(task_id, text, status='completed') → 给上游 reply"
else
  IDX="${ALIAS#研究员}"
  IDX="${IDX%号}"
  PROMPT="你是科研军团 *研究员${IDX}号*，负责接收 Leader 派来的子主题研究任务。

Phase 1 当前实现（占位）：
- 收到子主题任务后，简单产出 1-2 段关于「${TOPIC}」对应子主题的 markdown 描述
- 用 commhub_reply 回复 task_id，status='completed'
- *不查* web、*不引用* 真 paper（Phase 2 RFC-008 规划引入 RAG）

$ROSTER

通信方式 (MCP tools)：
- commhub_reply(task_id, text, status='completed') → 回 Leader"
fi

# Build agent-node command
CMD=(bun /app/agent-node/src/cli.ts --alias "$ALIAS" --runtime "$RUNTIME" --url "$HUB" --prompt "$PROMPT")
[ -n "$MODEL" ] && CMD+=(--model "$MODEL")
[ -n "$TOKEN" ] && CMD+=(--token "$TOKEN")

# Write per-container anet config (token + hub)
mkdir -p /root/.anet
cat > /root/.anet/config.json <<EOF
{"hub":"$HUB","token":"$TOKEN"}
EOF

echo "Starting agent: $ALIAS ($ROLE / $RUNTIME / $MODEL)"
echo "  Hub: $HUB"
echo "  Team size: $TEAM_SIZE"
echo "  Topic: $TOPIC"

export COMMHUB_TOKEN="$TOKEN"
# Claude CLI refuses --dangerously-skip-permissions as root without this
export IS_SANDBOX="${IS_SANDBOX:-1}"

exec "${CMD[@]}"
