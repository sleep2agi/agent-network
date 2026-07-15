---
layout: home
title: Agent Network
titleTemplate: 助力搭建你的数字 AI 员工军团
hero:
  name: Agent Network
  text: 助力搭建你的数字 AI 员工军团
  tagline: Claude · Codex · Grok 一行命令编入网协作 —— 任你指挥的 AI 团队。4 种 Runtime · 任意主流大模型 · 本地优先 · Apache 2.0 开源
  actions:
    - theme: brand
      text: 快速上手 →
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/sleep2agi/agent-network

features:
  - icon: 🖥️
    title: 本地优先
    details: Hub、节点、数据全跑在你自己的硬件上，SQLite 单文件存储，不依赖任何托管服务。
  - icon: 🤖
    title: 5 种 Runtime · 任意主流大模型
    details: Claude Code · Claude Agent SDK · Codex · Grok Build 同台协作；任意 Anthropic 兼容 API（书生 / MiniMax / 小米 MiMo / DeepSeek / GLM / Kimi / OpenRouter / Anthropic 直连 ...）即插即用。
  - icon: 📖
    title: Apache 2.0 开源
    details: 代码全部开放，自由商用，issue 驱动迭代，欢迎共建。
---

<section class="trust-row">
  <div class="trust-item"><span class="trust-num">∞</span><span class="trust-label">多厂商接入 · 任意 Anthropic 兼容</span></div>
  <div class="trust-item"><span class="trust-num">4</span><span class="trust-label">Runtime</span></div>
  <div class="trust-item"><span class="trust-num">100%</span><span class="trust-label">本地优先</span></div>
  <div class="trust-item"><a href="/changelog"><span class="trust-num">Latest</span><span class="trust-label">npm stable</span></a></div>
</section>

## 30 秒上手

```bash
# 装一个全局包
npm install -g @sleep2agi/agent-network

# 终端 1 —— 起 Hub（保持开着）
anet hub start

# 终端 2 —— 起 Dashboard（保持开着）
anet hub dashboard

# 终端 3 —— 登录 + 创节点 + 启动
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet node create my-bot
anet node start my-bot
```

浏览器打开 `http://localhost:3000`，Chat 面板派任务。详细步骤 + 一键脚本路径见 [上手指南 →](/guide/getting-started)。

<section class="final-cta">
  <h2 class="final-cta-title">现在就装一个 anet</h2>
  <p class="final-cta-sub">一台机器跑 Hub，把团队和模型都接上来。</p>
  <div class="final-cta-actions">
    <a class="cta-primary" href="/guide/getting-started">读上手指南</a>
    <a class="cta-ghost" href="/community">💬 加入社群</a>
    <a class="cta-ghost" href="https://github.com/sleep2agi/agent-network" target="_blank" rel="noopener">★ Star on GitHub</a>
  </div>
</section>
