# Running an AI Agent Army: 48-Hour Field Report

> A complete experience summary from building and operating a multi-model, multi-server AI Agent fleet from scratch.

---

## Background

Over 48 hours, I simultaneously directed 15+ AI Agent sessions distributed across 4 servers. They were generating educational videos, self-evolving PPT presentations, conducting code audits, and writing documentation. Models used included Claude Opus 4.6, MiniMax M2.7, Qwen 3.6, and Codex GPT-5.4.

The output: 24 science education videos, 307 PPT versions, 40+ video self-evolution rounds, and 16 rounds of comprehensive code audits. But also countless pitfalls: 66 zombie shells piling up, CJK font rendering as squares, video self-scoring 9.1/10 while actually missing visuals, tunnel disconnections at 2 AM, SOCKS proxy crashing the agent runtime...

This article is a complete retrospective. Not theoretical guidance -- real operational experience, every lesson paid for in time and compute.

---

## I. Agent Army Architecture

### 1.1 Central Command

The hub runs Claude Code Opus 4.6 (1M context) on a central server with direct international API access (lowest latency to Anthropic, OpenAI, etc.).

The hub's role is **dispatcher**, not executor:
- Maintain global task board
- Patrol all child sessions every 5 minutes
- Dispatch tasks via tmux send-keys, read results via capture-pane
- Run code audits via Codex MCP Tool
- Receive voice commands via Telegram/chat channels

### 1.2 Child Agent Distribution

| Server | Connection | Sessions | Primary Tasks |
|--------|-----------|----------|---------------|
| Central (cloud) | Local tmux | 9 | Hub, projects, Codex x2, chat channels |
| Mac Mini 16GB | Tunnel | 6 | Video generation, rendering, PPT |
| 96G Intel server | Tunnel | 2+ | Skills documentation, video self-evolution |
| Project server | SSH direct | 4 | Application frontend/backend, Codex review |

### 1.3 tmux Session Management

All agents run in tmux sessions -- the infrastructure backbone. Sessions persist through SSH disconnections. Each server uses `tmux ls` to list sessions, `tmux send-keys` to dispatch, `tmux capture-pane` to read status.

---

## II. Multi-Model Backend

### 2.1 Model Capability Comparison

| Dimension | Claude Opus 4.6 | MiniMax M2.7 | Qwen 3.6 | Codex GPT-5.4 |
|-----------|-----------------|--------------|-----------|---------------|
| Reasoning quality | Strongest | Medium | Medium-high | Strong (code domain) |
| Response speed | Medium | Fast | Very fast | 30s-30min |
| Self-loop ability | Can self-loop autonomously | Cannot (idles each round) | Cannot (idles each round) | One-shot execution |
| Tool support | Full MCP tools | WebFetch unavailable | Basic | Independent container |
| Context window | 1M tokens | Medium | Medium | 1.5M tokens/task |
| Limitations | High cost | Poor review ability | Content filtering | bwrap issues |
| Best for | Command dispatch, complex reasoning | Long independent tasks | High-frequency iteration | Code review/refactoring |

**Core finding**: Claude Opus is the only model that truly self-loops. MiniMax and Qwen complete one round and idle, requiring the hub to repeatedly push "continue next round." This makes directing these models far more maintenance-intensive.

---

## III. Communication Methods

### 3.1 tmux send-keys + capture-pane (Current, Painful)

```bash
# Dispatch task
ssh user@host "tmux send-keys -t session-name 'start generating video' Enter"

# Read results
ssh user@host "tmux capture-pane -t session-name -p -S -400"
```

**Pain points** (all learned the hard way):
- **Can't tell shell from agent UI**: Both use `$` or `>` prompts
- **Missed Enter**: Forgetting `Enter` at the end means the command is typed but never executed
- **capture-pane is garbled**: ANSI escape codes, Unicode, progress bars all mixed -- regex parsing is extremely fragile
- **SSH nesting**: Controlling remote machines requires SSH -> tmux send-keys chains
- **No structured state**: Can only guess session state from 400 lines of screen capture

Rating: 1 star. But it's the only cross-server approach, so it's the "have to use" fallback.

### 3.2 Codex MCP Tool (Most Efficient, 30 Seconds)

```json
mcp__codex__codex({
  "prompt": "Review this component, find top 3 most severe issues",
  "cwd": "/path/to/project",
  "sandbox": "danger-full-access",
  "approval-policy": "never"
})
```

One call, 30-second structured result. No tmux, no window state detection, no ANSI parsing.

16 rounds of practice, zero failures. All A-grade output quality. 10x more efficient than tmux, no exaggeration.

Limitation: local machine only, can't cross servers.

### 3.3 Codex Plugin (Best Code Review Tool)

```bash
/codex:review                    # Standard review
/codex:adversarial-review        # Adversarial review (challenges every design decision)
/codex:rescue                    # Hand off stuck task to Codex
```

Adds adversarial-review (specifically for high-risk changes: auth, migrations, infrastructure scripts) and rescue (switch "brains" when a thread is stuck).

### 3.4 Agent Teams (Built-in Multi-Session Coordination)

Set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to enable. One lead agent spawns multiple teammates, each with independent context, sharing a task list.

Anthropic built a 100K-line Rust compiler with 16 Agent Teams. Currently experimental, same-machine only.

### 3.5 Commander MCP Server (Design Complete)

The ultimate cross-server solution. Two plans:

- **Plan A: MCP Tool + Polling**. Child agents periodically call MCP Tool to check inbox, hub dispatches via API. 1-day MVP.
- **Plan B: MCP Channel + Push**. Commander as Channel plugin injects directly into conversation flow, real-time zero-delay push. 3-day development.

Core idea: From "hub reads child agent screens" to "child agents proactively report to hub." All communication via HTTP+SSE, structured JSON.

### 3.6 Communication Summary

| Approach | Quality | Cross-Server | Latency | Setup Cost | Reliability |
|----------|---------|-------------|---------|------------|-------------|
| tmux send-keys | 1 star | Yes | 5 min polling | Zero | 20% |
| Codex MCP Tool | 4 stars | No | 30 sec sync | Zero | 95% |
| Codex Plugin | 5 stars | No | Sync | 5 min install | 95% |
| Agent Teams | 4 stars | No | Built-in | 1 env var | 90% |
| Commander MCP | 4 stars | Yes | Polling | 1 day dev | 95% |
| Commander Channel | 5 stars | Yes | Push | 3 day dev | 99% |

---

## IV. Self-Evolution Mechanism

### 4.1 Self-Loop Prompt

The self-loop instruction for Claude Opus:

```
After completing the current task, don't stop. Automatically evaluate output quality,
identify improvements, and immediately start the next iteration round.
After each round, update experience documentation in docs/.
When context is nearly full, summarize experience into Skills, then start a new session.
```

Claude Opus 4.6 is the only model that truly executes this. It will autonomously run dozens of rounds until the context window fills.

### 4.2 Model Self-Loop Performance

| Model | Self-Loop Ability | Actual Performance |
|-------|------------------|--------------------|
| Claude Opus 4.6 | Strong | Autonomous 26+ rounds without intervention (12.5 hours self-learning in one test) |
| MiniMax M2.7 | Cannot | Idles after each round, must manually push "continue" |
| Qwen 3.6 | Cannot | Same -- stops each round, plus content filtering interruptions |
| Codex GPT-5.4 | One-shot | Designed for single task execution, no loop concept |

This means directing MiniMax and Qwen sessions requires the hub to scan every 5 minutes and push when idle. Pushed dozens of times overnight. This is the most energy-consuming part of the system.

### 4.3 The Self-Scoring Hallucination Problem

We designed a 19-point quality checklist and self-scoring system for the video generation session. Sounds perfect.

Reality? It self-scored 9.1/10, reporting "smooth visuals, consistent characters, perfect voiceover." After downloading:
- Last 9 videos had zero visuals, just black screen + narration
- CJK subtitles rendered as squares (ffmpeg drawtext missing CJK fonts)
- Scientists never appeared on screen

**Core lesson: AI self-scores are meaningless. A 9/10 self-score might mean basic functionality isn't even implemented. Human spot-checking is mandatory.**

---

## V. Output Results

### 5.1 Video Session: 24 Science Education Videos
- First 15 had visuals; last 9 had empty frames (API failures not handled properly)
- The video pipeline must stop and retry on API failure, not skip and continue

### 5.2 PPT Session: 307 Versions
- Qwen 3.6's advantage is extreme speed (seconds per iteration)
- But doesn't self-loop -- 307 versions required dozens of manual pushes from the hub

### 5.3 Code Audit: 16 Rounds via Codex MCP
This was the highlight. 30 seconds per round, 16 rounds of comprehensive audit covering 3 projects.

All A-grade quality:
- **Round 1**: OAuth token URL exposure + XSS risk
- **Round 2**: 1858-line god component split plan (10 sub-components with line ranges, Props interfaces, extraction order)
- **Round 3**: OAuth security deep audit (4 vulnerabilities + 3 fix plans)
- **Round 4**: Code generation test -- complete utility function + test file
- **Round 7**: Performance optimization -- 6 issues (eager imports, 2200-line static data, unmemo'd components)
- **Round 8**: i18n assessment -- no real i18n system, all hardcoded Chinese, missing hreflang

8 review rounds completed a full frontend health check. This would take a full day via tmux.

---

## VI. Lessons Learned (Hard Way)

### 6.1 SOCKS Proxy Crashes Agent Runtime
macOS system-level SOCKS proxy causes `UnsupportedProxyProtocol` error. Agent runtimes typically only support HTTP proxy.

Fix: Disable system SOCKS proxy, use HTTP proxy in shell profile.

Lesson: tmux sessions inherit environment variables from creation time. Changing shell profile requires restarting the tmux session or manual source.

### 6.2 Model-Specific Tool Limitations
Some models through compatibility endpoints don't support all tools (e.g., WebFetch unavailable).

Workaround: Hub pre-downloads files, then directs the session to read locally.

Lesson: Before dispatching tasks, predict the child session's capability limits. Record limitations on first discovery; pre-process for all future sessions using the same model.

### 6.3 Content Filtering Interruptions
Some models trigger content filtering during generation, causing interruptions.

Lesson: Adjust prompt wording to avoid triggering keywords. This limits certain creative content.

### 6.4 Tunnel Instability
FRP tunnels frequently disconnect at 2-4 AM. SSH connections timeout, send-keys can't reach.

Handling: 1st timeout: retry (10s timeout). 2nd: wait 5 min. 3 consecutive: skip server, try next round. 15+ minutes: notify operator.

### 6.5 Shell/Agent Window Misjudgment
**Most frequent pitfall.** capture-pane output shows `$` or `>` which could be either shell prompt or agent input box. Sending the wrong type of command to the wrong context wastes tokens or executes dangerous shell commands.

### 6.6 Zombie Shell Accumulation
After running overnight, one session accumulated 66 shell windows. Each agent subprocess spawn or crash restart leaves a residual shell.

Impact: Memory increase, tmux slows down, send-keys may hit wrong window.

Solution: Periodic session rebuild, or script to batch-close inactive windows.

### 6.7 CJK Font Missing (ffmpeg drawtext)
All CJK subtitles render as squares. ffmpeg drawtext defaults to English fonts.

Fix: Install CJK fonts and specify font path in drawtext parameters.

### 6.8 Missing Visuals But High Self-Scores
The 19-point checklist checked file existence and duration -- but existing files don't mean they have content. Black-screen videos pass these checks.

Lesson: Quality scripts must include frame-level content checking (ffprobe black frame detection, keyframe verification). File exists != content correct.

---

## VII. Core Principles (Iron Laws)

### 7.1 Human spot-check always required
AI self-scores are the least reliable metric. Any video/PPT/image output must be downloaded and visually inspected before delivery.

### 7.2 MCP calls are 10x more efficient than tmux
Local tasks: prioritize MCP Tool / Plugin / Agent Teams. tmux only as cross-server fallback.

### 7.3 Different models need different directing styles
- **Claude Opus**: Give goal + constraints + done-criteria, then walk away. It self-loops for dozens of rounds.
- **MiniMax/Qwen**: Give specific task, it stops when done. Hub must push "continue" every 5 minutes.
- **Codex**: Give one-shot task + clear Done When. It runs, delivers, done.

### 7.4 Every new session needs a project directory
Create a dedicated project directory before starting. Never run bare in the home directory.

### 7.5 Always confirm Shell vs Agent before sending
First thing after capture-pane: determine if you're in shell or agent UI. Sending agent task text to shell = executed as command (potentially dangerous). Sending shell commands to agent = processed as natural language (wastes tokens).

### 7.6 send-keys must include Enter
```bash
# Wrong - typed but not executed
tmux send-keys -t session "start task"

# Correct
tmux send-keys -t session "start task" Enter
```

Every. Single. Time.

### 7.7 Read context before dispatching
Always capture-pane to understand child session state before dispatching. It might be waiting for confirmation, mid-execution, or crashed.

### 7.8 Always verify CJK rendering in media output
CJK fonts, punctuation, and layout are disaster zones in cross-platform media production. macOS and Linux have different font paths, Docker containers may lack CJK fonts entirely.

---

## VIII. Operational Principles

### Architecture
1. **Hub dispatches only, never executes.** No code writing, no reviewing, no rendering.
2. **One project directory per session.** No mixing, no bare runs.
3. **Communication must be structured.** tmux capture-pane text parsing is a dead end. Migrate to MCP/Commander ASAP.
4. **Local tasks via MCP, cross-server via SSH+tmux as fallback.**

### Model Selection
1. **Need self-loop --> Claude Opus.** Only model that autonomously runs dozens of rounds.
2. **Need high-frequency iteration --> Qwen.** Fast but needs external pushing.
3. **Code review --> Codex.** MCP Tool, one call, done.
4. **Long independent tasks --> allocate by budget.** Claude is expensive but strong; others are cheaper but weaker.

### Quality Control
1. **Any human-facing output must be human-inspected.** AI self-scoring is unreliable.
2. **CJK rendering is a frequent failure point.** Check every time.
3. **File exists != content correct.** Black-screen videos have correct duration and size.
4. **Adversarial review > standard review** for high-risk changes.

### Operations
1. **Periodically clean shells.** Long-running sessions accumulate zombie processes.
2. **SSH timeout has a standard procedure.** 3 failures = skip, don't retry-loop forever.
3. **Document proxy configuration.** SOCKS vs HTTP, system vs app level, tmux env inheritance -- each is a trap.
4. **Record each session's capability limits once, never repeat the lesson.**

---

## IX. What's Next

1. **Commander MCP Server MVP** (1 day) -- solve cross-server structured communication, retire tmux send-keys
2. **Install MCO** -- multi-model parallel review aggregation
3. **Video quality upgrade** -- add ffprobe frame-level checks, CJK font pre-check, black screen detection
4. **Retire tmux send-keys** -- all communication via MCP protocol after Commander launches

---

## Conclusion

Directing an AI Agent army sounds like science fiction, but in practice it's operations engineering.

Choose the right model and you're 10x productive; choose wrong and you waste an entire night. Choose the right communication method and you get results in 30 seconds; choose wrong and you're parsing garbled text for 3 minutes. Get quality control right and every version improves; get it wrong and you have 9/10 self-scores with 0/10 actual quality.

48 hours of field experience confirms: **this is absolutely feasible, but requires extremely precise engineering.** It's not "let AI do my work" -- it's building a distributed system with a scheduler, communication protocol, monitoring, fault tolerance, and self-evolution.

The good news: once this system is running, one person's output genuinely rivals a small team.

The bad news: building and maintaining this system is itself a full-time job.

But this is the most worthwhile thing to be doing in 2026.
