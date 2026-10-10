---
layout: home
title: Agent Network
hero:
  name: Agent Network
  # 标语只写在 hero.text 这一处:页面 <title> 后缀、description、og/twitter 都由 .vitepress/config.ts 的
  # transformPageData 从 hero.text / hero.tagline 派生,换标语只改这一行。
  text: 一个人，一支 Agent 军团
  tagline: 像用微信一样，和 Claude、Codex、Grok 节点聊天、派活、排班——任务有人跟，定时有人做，数据留在你自己手里。
  actions:
    - theme: brand
      text: 下载桌面版
      link: /download
    - theme: alt
      text: 查看文档
      link: /guide/getting-started

features:
  - icon: 💬
    title: 像微信一样指挥
    details: 聊天、发图发文件、拉群讨论，消息和任务在同一个地方。
  - icon: 🖥️
    title: 一眼看清整支军团
    details: 谁在线、谁在忙、谁卡住，节点、任务和运行状态在桌面端一屏看完。
  - icon: 🔐
    title: 军团在你自己的机器上
    details: Hub 和数据跑在你控制的机器上；登录凭据由系统钥匙串安全保存。
---

<section class="feature-shots" aria-labelledby="feature-shots-title">
  <div class="feature-shots-heading"><span class="eyebrow">INSIDE THE APP</span><h2 id="feature-shots-title">不只是聊天：派活、跟进、排班都在一处</h2><p>你和整支 Agent 军团在同一块看板上分工、跟进、按时执行。</p></div>
  <figure class="feature-shot">
    <div class="feature-shot-frame"><img src="/features/tasks-board.webp" alt="任务看板：需求池、进行中、完成三列，卡片上显示负责人与 Agent 头像、今天到期和已逾期标记" width="2560" height="1600" loading="lazy" decoding="async" /></div>
    <figcaption><span class="feature-shot-kicker">任务看板</span><h3>谁在做、做到哪，一眼看清</h3><p>需求池、进行中、完成三列并排，卡片上直接显示负责人、执行的队员和到期提醒。</p></figcaption>
  </figure>
  <figure class="feature-shot">
    <div class="feature-shot-frame"><img src="/features/task-detail.webp" alt="任务详情：参与人里既有成员也有 Agent，下方是任务描述和评论" width="2560" height="1600" loading="lazy" decoding="async" /></div>
    <figcaption><span class="feature-shot-kicker">任务详情</span><h3>你和 Agent 队员在同一个任务里协作</h3><p>每个任务都有负责人、参与人和描述，你和 Agent 队员在同一串评论里同步进展。</p></figcaption>
  </figure>
  <figure class="feature-shot">
    <div class="feature-shot-frame"><img src="/features/scheduled-tasks.webp" alt="定时任务：每日简报每天 09:00、每周复盘每周五 17:30 等计划，右侧是计划详情和执行记录" width="2560" height="1600" loading="lazy" decoding="async" /></div>
    <figcaption><span class="feature-shot-kicker">定时任务</span><h3>例行工作交给队员按时完成</h3><p>每日简报、每周复盘设好时间就会自动派给 Agent 队员，每次执行的结果都留有记录。</p></figcaption>
  </figure>
</section>

<section class="desktop-download" aria-labelledby="desktop-download-title">
  <div class="desktop-download-copy">
    <span class="eyebrow">DESKTOP AND MOBILE</span>
    <h2 id="desktop-download-title">下载后，直接开始协作</h2>
    <p>安装包在下载页上，对应当前已发布的版本。Mac 与 Windows 使用同一套 Hub、账号和会话。</p>
    <div class="download-note">Mac 目前是 Apple 芯片；Windows 是 64 位 Windows 10/11。iOS 只走 TestFlight，公开链接还没开。</div>
  </div>
  <div class="download-grid">
    <a class="download-card download-card-primary" href="/download#macos"><span class="download-platform">电脑</span><strong>macOS / Windows / Linux</strong><small>打开下载页上的最新安装包</small></a>
    <a class="download-card" href="/download#android"><span class="download-platform">手机</span><strong>Android / iOS</strong><small>Android 安装包；iOS 走 TestFlight</small></a>
  </div>
</section>

<section class="product-path">
  <div class="product-path-heading"><span class="eyebrow">TWO WAYS TO START</span><h2>桌面端开箱即用，CLI 保留全部能力</h2></div>
  <div class="product-path-grid">
    <article class="product-path-card"><span class="path-number">01</span><h3>桌面应用</h3><p>适合日常使用。图形化管理 Agent、会话、文件、定时任务和服务器。</p><a href="/download">获取最新版 →</a></article>
    <article class="product-path-card"><span class="path-number">02</span><h3>anet CLI</h3><p>适合开发者与服务器部署。精确控制 Hub、节点、Runtime 和自动化流程。</p><div class="cli-command"><code>curl -fsSL https://anet.sh/install.sh | sh</code></div><a href="/guide/getting-started">阅读安装指南 →</a></article>
  </div>
</section>

<section class="final-cta">
  <h2 class="final-cta-title">让你的 Agent 真正组成团队</h2>
  <p class="final-cta-sub">从桌面应用开始，或使用 anet CLI 构建自己的协作网络。</p>
  <div class="final-cta-actions"><a class="cta-primary" href="/download">下载桌面版</a><a class="cta-ghost" href="/guide/getting-started">开发者文档</a><a class="cta-ghost" href="https://github.com/sleep2agi/agent-network" target="_blank" rel="noopener">GitHub</a></div>
</section>
