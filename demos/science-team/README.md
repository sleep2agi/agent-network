# Science Team Demo

科研军团 — N 个 Agent 协作产出 AI 综述。

> Phase 1 (issue [#51](https://github.com/sleep2agi/agent-network/issues/51))：**scaffold only**。Leader 简单 round-robin / echo 分派，研究员产 markdown 占位段落。智能 fan-out + 子主题切分 + 真 aggregate **Phase 2 (RFC-008) 实施**。

## 架构

```
                  CommHub Server (port 9200)
                          │
                ┌─────────┴─────────┐
                │                   │
         研究Leader             研究员 1..N-1
        (claude-agent-sdk)    (claude-agent-sdk, intern-s1-pro)
        (intern-s1-pro)
                │                   ▲
                └── send_task ──────┘
                    （round-robin Phase 1）
```

Vendor：**书生 (Intern AI Lab)** Anthropic-compatible endpoint
- `baseUrl: https://chat.intern-ai.org.cn` (no `/anthropic` suffix)
- `model: intern-s1-pro` (lowercase)
- 拿 API key：https://chat.intern-ai.org.cn/

## 启动

```bash
cd demos/science-team

# 1. 配置
cp .env.example .env
# 编辑 .env 填入 INTERN_API_KEY（必填）+ RESEARCH_TOPIC（可选）

# 2. 启动（选规模 — 5 / 10 / 20）
docker compose -f docker-compose.5.yml up -d --build       # 1+4   = 5 agent
docker compose -f docker-compose.10.yml up -d --build      # 1+9   = 10 agent
docker compose -f docker-compose.20.yml up -d --build      # 1+19  = 20 agent

# 3. 看 leader 日志（确认全员上线）
docker compose -f docker-compose.5.yml logs -f leader

# 4. 派任务（任选一种）
#  A) 通过 commhub MCP（任何 anet-connected agent 都可发）：
#     commhub_send_task(alias="研究Leader", task="写一篇关于 LLM RAG 的综述")
#
#  B) 直接 curl（通过 seed 写入的 ntok_）：
docker compose -f docker-compose.5.yml exec server sh -c \
  'NTOK=$(cat /shared/ntok 2>/dev/null) ; echo "Use this token to call /mcp send_task: $NTOK"'
```

## 预期输出

Phase 1 的 leader 不做真 aggregate，只 round-robin 分派 + 简单拼接 reply。所以
output 大致形如：

```markdown
# 综述：<RESEARCH_TOPIC>

## 子主题 1（研究员1号）
<研究员1号 markdown 段落>

## 子主题 2（研究员2号）
<研究员2号 markdown 段落>

...

## 子主题 N-1（研究员${N-1}号）
<研究员${N-1}号 markdown 段落>
```

> 这是 **占位**输出。真正的智能 fan-out（leader 自动切分子主题、给每个研究员分配
> 不重复的领域、最后 dedup + aggregate）由 [RFC-008](https://github.com/sleep2agi/agent-network/issues/51) Phase 2 实施。

## 选规模

| 规模 | 容器数 | 适合场景 | host 要求 |
|------|--------|----------|-----------|
| 5    | 5 + server + seed = 7 | 本地快速验证，5 min cold start | 4 GB+ |
| 10   | 10 + 2 = 12 | demo 录屏 sweet spot | 8 GB+ |
| 20   | 20 + 2 = 22 | "20 个 agent 协作" 展示用 | 16 GB+ |

> N=20 同时跑 20 个 SSE 长连接，注意 host file descriptor limit (`ulimit -n`)。

## 配置说明

| 环境变量 | 必填 | 说明 |
|---------|------|------|
| `INTERN_API_KEY` | ✅ | 书生 API key（注入到每个 agent 的 `ANTHROPIC_AUTH_TOKEN`） |
| `RESEARCH_TOPIC` |   | 综述方向，注入到 system prompt。默认「全面 AI 综述」 |
| `COMMHUB_AUTH_TOKEN` |   | hub admin bootstrap token。默认 `science-team-token`（v0.8 起仅 `/api/*` 只读软废弃） |
| `HUB_PORT` |   | 宿主机映射端口，默认 9200，本地占用就改 9210 etc. |

## 关联

- Spec issue：[#51](https://github.com/sleep2agi/agent-network/issues/51)
- CLI path（互补）：`anet demo science-team` — 由 `agent-network/bin/cli.ts` 提供，无 Docker
  时用 wizard 直接 spawn 本地 agent 进程。**Phase 1 联合 ship**。
- 长期编排 spec：RFC-008（SDK马 起草中，Phase 2 fan-out + aggregate）

## 停止

```bash
docker compose -f docker-compose.5.yml down
# 或彻底清理（连同 ntok_ shared volume）：
docker compose -f docker-compose.5.yml down -v
```

## Phase 1 不做（明示）

- ❌ Leader 智能 fan-out / 子主题自动切分
- ❌ 研究员之间 cross-talk / peer review
- ❌ 真 paper 检索 / RAG
- ❌ 最终 dedup + aggregate 综述
- ❌ Dashboard team 聚合视图（issue [#50](https://github.com/sleep2agi/agent-network/issues/50) N站马 联动）

以上 Phase 2 RFC-008 起手。
