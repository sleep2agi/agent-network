# Agent Orchestration Guide

> From tmux send-keys to production-grade multi-agent orchestration

---

## Approach Comparison

| # | Approach | Cross-Server | Latency | Config Cost | Maintenance | Reliability | Status |
|---|----------|-------------|---------|-------------|-------------|-------------|--------|
| 1 | tmux send-keys | Yes (SSH) | Poll 5min | Zero | High (shell pile-up/window misjudge) | 20% | Legacy |
| 2 | Codex MCP Tool | Local | Sync 30s | Zero (built-in) | Zero | 95% | Verified |
| 3 | Codex Plugin | Local | Sync | 3 commands | Zero | 95% | Verified |
| 4 | Agent Teams | Local | Built-in | 1 env var | Low | 90% | Enabled |
| 5 | MCO | Local | Parallel | npm install | Low | 90% | Available |
| 6 | oh-my-claudecode | Local | Git worktree | npm install | Medium | 85% | Community |
| 7 | Commander MCP | Yes | Polling | 1 day dev | Medium | 95% | Designed |
| 8 | Commander Channel | Yes | Push | 3 day dev | Medium | 99% | Designed |

### Cost Analysis

| Dimension | tmux | MCP Tool | Plugin | Agent Teams | Commander |
|-----------|------|----------|--------|-------------|-----------|
| **Setup time** | 0 min | 0 min | 5 min | 1 min | 1 day |
| **Per-dispatch time** | 3-5 min (SSH+capture+judge+send) | 30 sec | 10 sec (/codex:review) | Built-in auto | 1 sec (API call) |
| **Human intervention** | Every 5 min push idle | None | None | Occasional | None |
| **Typical failures** | Shell/agent misjudge, missed Enter, tunnel drops | bwrap config needed | Needs session restart to load | Experimental feature | Need to maintain server |
| **Best for** | Cross-server fallback | Local code review | Local review+rescue | Local parallel tasks | Cross-server orchestration |

### Field Experience Ratings

| Approach | Output Quality | Autonomy | Issues Hit | Overall |
|----------|---------------|----------|------------|---------|
| tmux + Claude Opus | High (15 episodes) | Medium (needs pushing) | Many (66 shells/inconsistency) | B -- high output, high maintenance |
| tmux + MiniMax | Low (CJK rendering bugs) | Low (poor reviewer) | Many (font/WebFetch) | D -- missed basic issues |
| tmux + Qwen | Medium (307 PPT versions/40+ video rounds) | Low (idle each round) | Medium (content filtering/no self-loop) | C -- fast but not self-driven |
| Codex MCP Tool | High (16 rounds A-grade) | High (one call, done) | Zero | A+ -- most efficient approach |

---

## 1. Ready-to-Use Approaches

### 1.1 Codex MCP Tool (Recommended)
```json
mcp__codex__codex({
  "prompt": "review the code",
  "cwd": "/path/to/project",
  "sandbox": "danger-full-access",
  "approval-policy": "never"
})
```
- 30-60 second results, A-grade quality
- 16 rounds of practice, zero failures
- Limitation: local machine only

### 1.2 Codex Plugin
```bash
/codex:review                  # Standard review
/codex:adversarial-review      # Adversarial review (required for high-risk changes)
/codex:rescue                  # Hand off task to Codex
```
- Adds adversarial-review and rescue modes beyond MCP Tool
- Built-in background execution + status management

### 1.3 Claude Code Agent Teams
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json
- One lead + multiple teammates, each with independent context
- Anthropic built a 100K-line Rust compiler with 16 agents
- Limitation: same machine only

### 1.4 MCO - Multi-CLI Orchestrator
- Neutral orchestration layer, dispatches to Claude/Codex/Gemini/Qwen simultaneously
- Parallel execution + result aggregation (JSON/SARIF/Markdown)
- GitHub: https://github.com/mco-org/mco
```bash
npm install -g @mco/cli
mco review  # Multi-model review with aggregated results
```

---

## 2. Community Solutions

### 2.1 oh-my-claudecode (Most Mature Multi-Agent Framework)
- 5+ Claude Code instances in parallel, isolated Git worktrees
- Shared task list coordination
- 3-5x speedup, 30-50% cost reduction
- GitHub: https://github.com/yeachan-heo/oh-my-claudecode

### 2.2 Citadel (Enterprise-grade)
- 4-layer routing + `/do` command
- Campaign persistence across sessions
- Circuit breaker + 6 production skills
- GitHub: https://github.com/SethGammon/Citadel

### 2.3 claude-octopus (Multi-Provider)
- 8+ provider coordination (Codex/Gemini/Perplexity/Qwen/Ollama)
- Consensus-gated quality control
- 47 commands, 50 skills
- GitHub: https://github.com/nyldn/claude-octopus

---

## 3. Cross-Server Solutions

### 3.1 Commander MCP Server (Design Complete)
- See `commander-mcp-design.md` (full design document)
- Plan A: MCP Tool + polling (MVP in 1 day)
- Plan B: MCP Channel + push (elegant, 3 days)

### 3.2 File Protocol + SSH (Fastest to Deploy)
```bash
# Child agent writes status
echo '{"status":"executing","task":"...","score":95}' > ~/session-status.json

# Hub reads status
ssh user@host cat ~/session-status.json
```

### 3.3 HTTP API Coordination
- Commander Server exposes REST API
- Child agents periodically POST status
- Hub GETs to query

---

## 4. Recommended Migration Path

### Phase 1: Immediate (Today)
1. Codex MCP Tool -- local code review/refactoring
2. Codex Plugin -- /codex:review + /codex:adversarial-review
3. Agent Teams -- for local parallel tasks
4. Keep tmux for remote sessions (fallback)

### Phase 2: This Week (1-3 days)
5. Install MCO -- multi-model parallel review aggregation
6. Evaluate oh-my-claudecode -- Git worktree parallel execution
7. Commander MCP Server MVP -- cross-server structured communication

### Phase 3: Next Week
8. Commander Channel -- push, no polling
9. Fully retire tmux send-keys

---

## 5. Pain Points and Solutions

| Pain Point | Solution | Priority |
|-----------|----------|----------|
| tmux can't distinguish shell vs agent | Commander MCP structured communication | P0 |
| Remote sessions often idle, need pushing | /loop self-check + hub patrol | P1 |
| MiniMax/Qwen don't self-loop | Stronger self-loop prompts + timed pushes | P1 |
| Tunnel instability | SSH tunnel backup + auto-reconnect | P2 |
| 66+ zombie shells accumulating | Periodic session rebuild + shell cleanup rules | P2 |
