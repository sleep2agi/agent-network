---
layout: home
title: Agent Network
titleTemplate: Build your AI agent army
hero:
  name: Agent Network
  text: Build your AI agent army
  tagline: Orchestrate Claude · Codex · Grok with one command into a coordinated AI team you direct. 4 runtimes · any mainstream LLM · local-first · Apache 2.0 open source
  actions:
    - theme: brand
      text: Get Started →
      link: /en/guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/sleep2agi/agent-network

features:
  - icon: 🖥️
    title: Local-first
    details: Hub, nodes, and data all run on your own hardware — single-file SQLite storage, no hosted service required.
  - icon: 🤖
    title: 4 runtimes · any mainstream LLM
    details: Claude Code · Claude Agent SDK · Codex · Grok Build working side by side; any Anthropic-compatible endpoint (InternLM / MiniMax / Xiaomi MiMo / DeepSeek / GLM / Kimi / OpenRouter / Anthropic direct ...) plugs straight in.
  - icon: 📖
    title: Apache 2.0 open source
    details: Fully open code, free for commercial use, issue-driven iteration — contributions welcome.
---

<section class="trust-row">
  <div class="trust-item"><span class="trust-num">∞</span><span class="trust-label">Multi-vendor · any Anthropic-compatible</span></div>
  <div class="trust-item"><span class="trust-num">4</span><span class="trust-label">Runtimes</span></div>
  <div class="trust-item"><span class="trust-num">100%</span><span class="trust-label">Local-First</span></div>
  <div class="trust-item"><a href="/en/changelog"><span class="trust-num">Latest</span><span class="trust-label">npm stable</span></a></div>
</section>

## 30-second quickstart

```bash
# Install one global package
npm install -g @sleep2agi/agent-network

# Terminal 1 — start the hub (keep open)
anet hub start

# Terminal 2 — start the dashboard (keep open)
anet hub dashboard

# Terminal 3 — log in, create + start an agent
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet node create my-bot
anet node start my-bot
```

Open `http://localhost:3000` in your browser and dispatch tasks from the Chat panel. For the full walkthrough + one-shot installer, see the [Getting Started guide →](/en/guide/getting-started).

<section class="final-cta">
  <h2 class="final-cta-title">Install anet now</h2>
  <p class="final-cta-sub">Run a Hub on one machine. Plug in your team and your models.</p>
  <div class="final-cta-actions">
    <a class="cta-primary" href="/en/guide/getting-started">Read the guide</a>
    <a class="cta-ghost" href="/en/community">💬 Community</a>
    <a class="cta-ghost" href="https://github.com/sleep2agi/agent-network" target="_blank" rel="noopener">★ Star on GitHub</a>
  </div>
</section>
