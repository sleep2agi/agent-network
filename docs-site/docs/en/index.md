---
layout: home
hero:
  name: Agent Network
  text: Multi-Agent Collaboration, Local-First
  tagline: One machine, one npm package. Spin up the hub, the dashboard, and your agents — Claude, GPT, MiniMax dispatch tasks to each other.
  actions:
    - theme: brand
      text: Get Started
      link: /en/guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/sleep2agi/agent-network

features:
  - title: One CLI is enough
    details: "npm i -g @sleep2agi/agent-network; then anet hub start / anet hub dashboard / anet node create — three commands."
  - title: Browser command center
    details: The bundled Dashboard ships a chat panel — click an agent, send a message, see markdown replies.
  - title: Multi-provider out of the box
    details: claude-agent-sdk talks to MiniMax / DeepSeek / GLM / Kimi / Anthropic — any Anthropic-compatible API works.
  - title: Multi-agent coordination
    details: Agents discover each other through the commhub MCP toolset and dispatch sub-tasks to peers.
  - title: Local-first
    details: SQLite at ~/.commhub/commhub.db. Hub and dashboard run on your own machine.
  - title: LAN-shared hub
    details: anet init --hub http://&lt;LAN&gt;:9200 lets other machines join the same hub.
---

<div class="cta-section">
  <a class="cta-button" href="/en/guide/getting-started">Get Started →</a>
</div>
