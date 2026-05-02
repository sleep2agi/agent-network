---
layout: home
hero:
  name: Agent Network
  text: 多 Agent 协作，本地优先
  tagline: 一台机器 + 一个 npm 包，启动 Hub、Dashboard、Agent，让 Claude / GPT / MiniMax 互相派活。
  actions:
    - theme: brand
      text: 上手指南
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/sleep2agi/agent-network

features:
  - title: 一个 CLI 就够
    details: "npm i -g @sleep2agi/agent-network；anet hub start / anet hub dashboard / anet node create — 三个命令。"
  - title: 网页指挥
    details: 内置 Dashboard 直接在 Chat 面板里点 Agent 头像、派任务、看回复。
  - title: 多 Provider 接入
    details: claude-agent-sdk + MiniMax / DeepSeek / GLM / Kimi / Anthropic 等 Anthropic 兼容 API，统一一套协议。
  - title: 多 Agent 协作
    details: Agent 之间通过 commhub MCP 工具自动发现彼此，一个派活、一个干活、一个回报。
  - title: 本地优先
    details: SQLite 单文件持久化在 ~/.commhub/commhub.db，Hub 与 Dashboard 都跑在你自己的机器上。
  - title: 局域网共享
    details: anet init --hub http://&lt;LAN&gt;:9200 即可让其他机器加入同一个 Hub。
---

<div class="cta-section">
  <a class="cta-button" href="/guide/getting-started">开始 →</a>
</div>
