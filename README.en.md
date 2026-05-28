<p align="center">
  <img width="1280" height="720" alt="Wire Grok Build into a 1000-agent network" src="./docs/images/grok-build-agent-network-cover.png" />
</p>

<h1 align="center">Agent Network</h1>

<p align="center">
  <strong>Multi-agent, one command. Let Claude / GPT / MiniMax / DeepSeek / GLM / Kimi / InternLM / OpenRouter work together on your machine.</strong>
</p>

<p align="center">
  Dev teams · content factories · research crews · debate clubs — all running on your own box.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
  <a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img src="https://img.shields.io/npm/v/@sleep2agi/agent-network.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@sleep2agi/agent-network"><img src="https://img.shields.io/npm/dm/@sleep2agi/agent-network.svg" alt="npm downloads"></a>
  <a href="https://anet.sh"><img src="https://img.shields.io/badge/docs-anet.sh-009e7e.svg" alt="Docs"></a>
  <a href="https://anet.sh/en/changelog"><img src="https://img.shields.io/badge/changelog-anet.sh-blue.svg" alt="Changelog"></a>
  <a href="https://github.com/sleep2agi/agent-network/actions/workflows/qa.yml"><img src="https://github.com/sleep2agi/agent-network/actions/workflows/qa.yml/badge.svg?branch=main" alt="anet QA (v0)"></a>
  <a href="https://github.com/sleep2agi/agent-network/commits/main"><img src="https://img.shields.io/github/last-commit/sleep2agi/agent-network" alt="last commit"></a>
  <a href="https://github.com/sleep2agi/agent-network/commits/main"><img src="https://img.shields.io/github/commit-activity/m/sleep2agi/agent-network" alt="commits per month"></a>
  <a href="https://github.com/sleep2agi/agent-network/releases"><img src="https://img.shields.io/github/release-date/sleep2agi/agent-network" alt="release date"></a>
  <a href="https://github.com/sleep2agi/agent-network"><img src="https://img.shields.io/github/stars/sleep2agi/agent-network?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <strong><a href="https://anet.sh">📖 Docs</a></strong> ·
  <strong><a href="https://www.npmjs.com/org/sleep2agi">📦 NPM</a></strong> ·
  <strong><a href="https://github.com/sleep2agi/agent-network">⭐ GitHub</a></strong> ·
  <strong><a href="https://github.com/sleep2agi/agent-network/discussions">💬 Discussions</a></strong> ·
  <strong><a href="https://anet.sh/en/community">💚 WeChat</a></strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.md">中文</a>
</p>

---

## 30-second quickstart (first-time install)

> **Prereq:** Node.js ≥ 22.13.0 (required by `@inquirer/prompts` and friends; older versions trip `EBADENGINE` warnings during install).

```bash
# Install one global package (pulls npm @latest — currently agent-network 2.2.9)
npm install -g @sleep2agi/agent-network

# Terminal 1 — start the hub (keep open)
anet hub start
#   listens on http://127.0.0.1:9200
#   SQLite at ~/.commhub/commhub.db
#   default account auto-created: admin / anethub

# Terminal 2 — start the dashboard (keep open)
anet hub dashboard
#   open http://localhost:3000

# Terminal 3 — log in, create + start an agent
anet login --username admin --password anethub
anet node create my-bot          # two-step picker: runtime → provider → API key
anet node start my-bot           # waits for "SSE connected"
```

Or via the one-shot installer (handles admin-password prompts and other UX):

```bash
curl -fsSL https://anet.sh/install.sh | bash
```

Send a task from the Dashboard's Chat panel. Spin up a second node and ask the first to delegate — the agents will discover each other and coordinate via MCP. That's it.

### Already have anet? Upgrade to the latest

```bash
anet upgrade            # bumps all four packages to npm @latest
anet project restart    # restart cwd nodes against the new version (see #117)
```

Full cross-version migration reference: [Upgrade Guide](https://anet.sh/en/guide/upgrade).

---

## One-line demos

```bash
export MINIMAX_KEY=sk-cp-xxx

# 6 agents, 9-step debate, ~10 minutes
anet demo debate --topic "Will AI create more jobs than it destroys?"

# 4 agents, content factory, ~3 minutes
anet demo socialmedia --topic "Focus in the AI era" --platform xiaohongshu
```

Each demo runs in an isolated network and cleans up afterwards — your `default` network stays untouched.

> 🎬 **Demo screencasts are on the way** (live GIFs of `anet demo debate` / `socialmedia`). In the meantime, the fastest path is just running the commands.

---

## What next

After the 30-second quickstart:

- 🎬 **Run a demo** — `anet demo debate` or `anet demo socialmedia` shows multi-agent coordination in real time
- 📖 **Read the docs** — [anet.sh/en/guide/getting-started](https://anet.sh/en/guide/getting-started) for the full walkthrough + [architecture overview](https://anet.sh/en/guide/architecture)
- 💚 **Join the community** — [Discussions](https://github.com/sleep2agi/agent-network/discussions) for async, or [WeChat](https://anet.sh/en/community) for real-time
- ⭐ **Star the repo** — if you find it useful, stars directly shape release cadence

---

## Why Agent Network

- **One CLI, four runtimes.** Run Claude Code CLI, the Claude Agent SDK, OpenAI's Codex SDK, and xAI's Grok Build ACP side-by-side on the same hub. Mix-and-match per role.
- **Eight LLM providers, one config switch.** Anthropic / OpenAI / MiniMax / DeepSeek / GLM (Zhipu) / Kimi (Moonshot) / InternLM / OpenRouter — all routed through `ANTHROPIC_BASE_URL`.
- **Local. LAN. Cross-server. Same Hub.** Hub binds to `127.0.0.1` for pure local mode; switch to `0.0.0.0` and **agents on other laptops, cloud VMs, or any servers across the internet can join the same Hub** over real-time SSE. SQLite stays on whichever box runs the Hub. No cloud account, no telemetry, no signup.
- **Mesh dispatch out of the box.** Agents discover each other via 17 MCP tools (`get_all_status`, `send_task`, `get_task`, …) and coordinate without you scripting the choreography.
- **Web Dashboard included.** Seven pages — Overview / Nodes / Tasks / Messages / Chat / Admin / Settings — plus a live node topology graph (grid / ring dual view, edges tiered by message frequency). Next.js 16 app, 4 themes, runs at `localhost:3000`.
- **Different from LangGraph / AutoGen / CrewAI:** anet is an **npm package**, zero Python dependency; **local-first**, not a SaaS framework; **multi-vendor without lock-in**, not OpenAI-by-default; **human + agent on the same surface** via Dashboard Chat, not pure programmatic orchestration.

---

## anet vs other multi-agent frameworks

| Dimension | anet | LangGraph | AutoGen | CrewAI |
|---|---|---|---|---|
| Deployment | Local-first + LAN/internet shared | Python library | Python library | Python library |
| Multi-vendor LLM | Anthropic / MiniMax / DeepSeek / GLM / Kimi / InternLM / OpenAI / OpenRouter | via LangChain | mainly OpenAI / Azure | via LangChain |
| Inter-agent transport | MCP + SSE hub, auto-discovery | Programmatic graph | Group chat | Hierarchy / sequential |
| Human + Agent on same surface | ✅ Dashboard Chat | n/a (program-only) | n/a | n/a |
| Package form | One npm package | pip + write your own server | pip + write your own server | pip + write your own server |

<sub>Cross-referenced against the public documentation of each project as of 2026-05; not a performance benchmark — a positioning comparison.</sub>

---

## Architecture

```
┌──────────┐   send_task   ┌────────────────┐   SSE push   ┌──────────┐
│ Agent A  │ ────────────→ │ CommHub        │ ───────────→ │ Agent B  │
│          │ ←──────────── │ Server (:9200) │ ←─────────── │          │
└──────────┘     reply     └───────┬────────┘    report    └──────────┘
                                   │
                          ┌────────┴────────┐
                          │ Dashboard       │
                          │ (:3000)         │
                          └─────────────────┘
```

```mermaid
flowchart LR
    A[Agent A] -- send_task --> H[(CommHub<br/>Server :9200)]
    H -- SSE push --> B[Agent B]
    B -- reply --> H
    H -- report --> A
    H --- D[Dashboard :3000]
    H -.- DB[(SQLite<br/>~/.commhub)]
```

Node onboarding flow (0 to online in 30 seconds):

```mermaid
flowchart LR
    C0[anet node create my-bot] --> C1{pick runtime}
    C1 --> C2{pick provider}
    C2 --> C3[enter API key]
    C3 --> C4[anet node start my-bot]
    C4 --> C5[SSE connected ✓ online]
```

- **MCP Streamable HTTP** at `/mcp` — agents and Claude Code / Codex connect here
- **SSE Push** at `/events/:alias` — server pushes tasks to agents in real time
- **REST** at `/api/*` — Dashboard, admin, monitoring, audit log
- **17 MCP tools** — `send_task`, `get_task`, `send_reply`, `report_status`, `get_all_status`, …

📖 Architecture deep dive → <https://anet.sh/en/guide/architecture>

---

## Runtimes

Pick one per node. Mix freely on the same hub.

| Runtime | What it does | Best for | Auth |
|---|---|---|---|
| `claude-code-cli` | Spawns your local `claude` CLI as a subprocess | Reusing a Claude Pro subscription, full Claude Code tool suite | `claude` already logged in |
| `claude-agent-sdk` | Programmatic Anthropic-compatible client | Anthropic, MiniMax, DeepSeek, GLM, Kimi, InternLM, OpenRouter via `ANTHROPIC_BASE_URL` | API key |
| `codex-sdk` | OpenAI's `@openai/codex-sdk` | Code generation, shell-heavy work | `codex auth login` or `OPENAI_API_KEY` |
| `grok-build-acp` | Local `grok agent stdio` over Agent Client Protocol | Joining Agent Network as a Grok Build node while reusing local Grok auth | local `grok` already logged in |

### Grok Build

Install and authenticate Grok Build CLI first:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
```

Then create and start a Grok node:

```bash
anet node create grok-demo --runtime grok-build-acp
anet node start grok-demo
```

Stable support: SSE task receive, Grok ACP execution, `grokSession` persistence/resume, CommHub replies, and explicit delegation through the `agent-node` wrapper. Current boundary: native Grok-side MCP tool injection is still treated as preview; CommHub delegation is handled by the wrapper.

Grok Build runtime guide → [`docs/grok-build-runtime.md`](./docs/grok-build-runtime.md)

📖 Runtime deep dive → <https://anet.sh/en/guide/runtimes>

---

## Providers

`claude-agent-sdk` is just an Anthropic Messages client — any Anthropic-compatible endpoint works. Every entry in `anet node create`'s built-in `VENDORS` list is **verified-with-real-call** (it only lands in the list after a real API call passes — the #104-B design); providers outside the list go through the `custom` vendor.

| Provider | Access | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic Claude | built-in vendor · verified | `https://api.anthropic.com` |
| MiniMax | built-in vendor · verified | `https://api.minimaxi.com/anthropic` |
| Xiaomi MiMo | built-in vendor · verified | `https://token-plan-cn.xiaomimimo.com/anthropic` |
| InternLM | built-in vendor · verified | `https://chat.intern-ai.org.cn` (bare domain, no `/anthropic`) |
| OpenAI Codex (`codex-sdk`) | built-in vendor · verified | n/a — `codex auth login` |
| DeepSeek / GLM / Kimi / OpenRouter / self-hosted | via the `custom` vendor (**not built-in — verify the endpoint + model id yourself**) | provide base URL + `ANTHROPIC_AUTH_TOKEN` |

📖 Per-provider keys, models, and access → <https://anet.sh/en/guide/multi-model>

---

## Packages

Stable, Apache-2.0, published to npm.

| Package | Version | Role |
|---|---|---|
| [`@sleep2agi/agent-network`](https://www.npmjs.com/package/@sleep2agi/agent-network) | `2.2.9` | `anet` CLI — hub / dashboard / agent / demo launcher + `grok-build-acp` runtime entrypoint + Xiaomi MiMo 5-model preset + envRef wizard-to-start auto-source ([see changelog](https://anet.sh/en/changelog)) |
| [`@sleep2agi/commhub-server`](https://www.npmjs.com/package/@sleep2agi/commhub-server) | `0.8.3` | MCP + REST + SSE hub (SQLite) + attachment metadata + `/api/server/:host/health` + `/api/server/:host/agents` |
| [`@sleep2agi/agent-network-dashboard`](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | `0.5.6` | Web UI — Next.js 16, image upload/paste, 4 themes, live topology, Servers panel polish, and Chat workflow improvements |
| [`@sleep2agi/agent-node`](https://www.npmjs.com/package/@sleep2agi/agent-node) | `2.4.6` | Agent runtime — Claude Code CLI / Claude Agent SDK / Codex SDK / Grok Build ACP + codex-sdk image input + Grok ACP stabilization and tool-state leak cleanup + Grok delegate parser broaden |

The CLI auto-fetches the hub and node packages on first use via `bunx` / `npx`. You only ever globally install one package.

---

## Repo layout

```
agent-network/   anet CLI         (npm: @sleep2agi/agent-network)
agent-node/      agent runtime    (npm: @sleep2agi/agent-node)
server/          CommHub server   (npm: @sleep2agi/commhub-server)
channel/         Claude Code channel plugin
docs-site/       VitePress source for https://anet.sh
docs/            design notes, RFCs, evolution log
tests/           Docker test matrix
```

The Dashboard lives in a separate repo: [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard).

---

## Status & known limitations

What's solid, and what to watch out for.

**Stable and E2E-tested**

- `anet hub start` / `hub dashboard` / `login` / `register` / `whoami` / `logout`
- `anet node create / start / stop / delete / ls / logs`
- `claude-agent-sdk` — 2 providers verified end-to-end via Docker E2E: InternLM + MiniMax
- Dashboard Chat — markdown, optimistic echo, source labels, error fallback, history persistence
- Multi-agent peer dispatch via `get_all_status` + `send_task` + `get_task`
- LAN-shared hub with `--host 0.0.0.0`

**Works, but not yet covered by full E2E**

- `claude-code-cli` runtime — runs locally; no automated regression yet (v0.8.2 fixed the session-resume default-loss bug, see [changelog](https://anet.sh/en/changelog))
- `codex-sdk` runtime — unit-tested; live OAuth path not in CI
- `anet network create` and cross-user network sharing — code merged, no E2E
- `anet channel add telegram | wechat | feishu` — Telegram path is exercised, others are not

**Not yet implemented**

- `anet license` / `anet activate` — v0.6 legacy commands, **no longer needed after Apache 2.0 OSS**. The Hub still keeps a SQLite `licenses` table for backward-compat (14-day trial on first run). On `license_expired`, see [troubleshooting](https://anet.sh/en/troubleshooting).
- **No official hosted Hub** — the product direction is Apache 2.0 + self-host + courses / consulting, **no SaaS**. For production go through [Docker](https://anet.sh/en/deploy/docker) or [production deployment](https://anet.sh/en/deploy/production).

---

> [!IMPORTANT]
> **Current stable** (Apache 2.0; all four packages at npm `latest`: agent-network `2.2.9` / agent-node `2.4.6` / commhub-server `0.8.3` / agent-network-dashboard `0.5.6`). **v0.10.10** adds the Xiaomi MiMo 5-model preset (mimo-v2.5-pro default + v2.5 / v2-pro / v2-omni / v2.5-tts-voicedesign) + envRef wizard-to-start auto-source (after `anet node create` you no longer need to `export` — `start` sources `.env` automatically) + [#192](https://github.com/sleep2agi/agent-network/issues/192) full `anet -v` prerelease suffix display + [#189](https://github.com/sleep2agi/agent-network/issues/189) Grok runtime parser broaden. **v0.10.9** ships codex-sdk image input + commhub attachment `meta_json` metadata. **v0.10.8** formalised Grok Build ACP: `anet node create --runtime grok-build-acp`, Grok ACP session persistence/resume, `-32603` stabilization, and cleanup for Grok tool-state leakage in final replies. The v0.10 line started with Direct Runtime + Observability Foundations and has continued through upgrade UX, batch wizard, codex-sdk, Dashboard topology, image attachments, and Grok Build. See the [changelog](https://anet.sh/en/changelog); project [open-sourced 2026-05-11](https://github.com/sleep2agi/agent-network/releases). The maintainer uses it daily and keeps polishing it — feedback and issues are very welcome. APIs may still shift between minor versions — pin your dependencies.
>
> **Safety disclaimer.** Each agent node runs with `dangerouslySkipPermissions: true` by default so it can call tools without prompting. Treat agents as untrusted code — run them in disposable working directories, not your `$HOME`. See [SECURITY.md](./SECURITY.md).

> [!WARNING]
> **Self-hosting on the public internet has real risks. Read this before opening firewall ports.**
> The current defaults are tuned for **local use**:
> 1. **Default credentials** `admin / anethub` — any public deployment must `anet passwd` immediately, or anyone scanning your port can walk in
> 2. **Hub binds to `127.0.0.1` by default** — for public mode (`--host 0.0.0.0`), put a reverse proxy with TLS in front (Caddy / Nginx). Never expose 9200 / 3000 directly
> 3. **Multi-tenant isolation relies on network scope** — v0.8 enforces user/node access by network; still do not place mutually untrusted users in the same network
> 4. **The tmux control plane** — disabled by default; only enabled with `COMMHUB_ENABLE_TMUX=1`, and public deployments must require admin auth, reverse-proxy TLS, and minimal exposure
>
> Full security audit + fix list: [`docs/open-source-security-risk-report.md`](./docs/open-source-security-risk-report.md) (v0.8.0 / v0.8.1 closed the P0 items)

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, branch naming, and the test matrix layout. By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

The fastest way to help right now: try the [30-second quickstart](#30-second-quickstart) and file anything that surprised you in [Discussions](https://github.com/sleep2agi/agent-network/discussions) or [Issues](https://github.com/sleep2agi/agent-network/issues).

---

## Security

Found a vulnerability? Please **don't** open a public issue. Use [GitHub Security Advisories](https://github.com/sleep2agi/agent-network/security/advisories/new) instead. See [SECURITY.md](./SECURITY.md) for the disclosure policy and threat model notes (especially around `dangerouslySkipPermissions` and LAN-exposed hubs).

---

## Ecosystem

Projects built on Agent Network or using anet to ship faster — full list at <https://anet.sh/en/ecosystem>.

| Project | What it is |
|---|---|
| 🌀 [Agent Network](https://github.com/sleep2agi/agent-network) | This very project — **dogfood**: agent-network is developed using agent-network agents in mesh |
| 📑 [PaperScope.ai](https://paperscope.ai) | Intelligent AI research paper discovery and explanation |
| 📊 [AI Insight](https://ai-insight.org) | Daily AI industry intelligence — research reports + signal-rich aggregator |

Using anet in your project? Open a PR to [`docs-site/docs/ecosystem.md`](./docs-site/docs/ecosystem.md) or post in [Discussions](https://github.com/sleep2agi/agent-network/discussions).

---

## Star History

<a href="https://star-history.com/#sleep2agi/agent-network&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=sleep2agi/agent-network&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=sleep2agi/agent-network&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=sleep2agi/agent-network&type=Date" />
  </picture>
</a>

---

## Resources

- [anet.sh](https://anet.sh) — full documentation site
- [Getting started](https://anet.sh/en/guide/getting-started) — verified end-to-end path
- [Runtimes](https://anet.sh/en/guide/runtimes) — Claude Code CLI vs Agent SDK vs Codex vs Grok Build ACP
- [Architecture](https://anet.sh/en/guide/architecture) — MCP, SSE, REST, SQLite schema
- 📚 **[R&D Methodology SOPs](./docs/sop/)** — Issue-centric AI-Native development workflow ([methodology overview](./docs/sop/methodology.md): Issue-Centric / Release Ops / Verify-First / Agent Dispatch / Retro)
- [@sleep2agi on npm](https://www.npmjs.com/org/sleep2agi) — package index
- [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions) — questions, ideas
- [GitHub Issues](https://github.com/sleep2agi/agent-network/issues) — bug reports

---

## Join us / 加入社群

Scan the QR code to join the **Agent Network 社区交流群** on WeChat — design discussions, troubleshooting, weekly updates.

<p align="center">
  <img src="https://anet.sh/community/wechat-group.jpg" alt="Agent Network WeChat group" width="320">
</p>

> The QR rotates every 7 days. If it's expired, the freshest one is always at <https://anet.sh/community/wechat-group.jpg>.

Prefer English / async? Use [GitHub Discussions](https://github.com/sleep2agi/agent-network/discussions).

---

## Credits

Built and maintained by [@sleep2agi](https://github.com/sleep2agi). If your team relies on this and wants to support development or sponsor a feature, open an issue tagged `sponsor` — happy to talk.

## License

[Apache-2.0](./LICENSE) © 2025–2026 sleep2agi contributors
