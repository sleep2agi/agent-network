<template>
  <section class="fg">
    <div class="fg-grid">
      <article class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </div>
        <h3 class="fg-title">一行装完</h3>
        <p class="fg-desc">npm i -g 一条命令把 Hub + Dashboard + Agent 三件套就位，零额外配置。</p>
      </article>

      <article class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8M12 18v2"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="11" r="1"/><circle cx="16" cy="11" r="1"/></svg>
        </div>
        <h3 class="fg-title">三种 Runtime</h3>
        <p class="fg-desc">同一 Hub 跑 Claude Code CLI、Claude Agent SDK、Codex SDK 三种内核，按角色挑。</p>
      </article>

      <article class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
        </div>
        <h3 class="fg-title">一键 Demo</h3>
        <p class="fg-desc">anet demo debate 6 角色辩论赛、anet demo socialmedia 4 角色社媒工厂，10 分钟跑完。</p>
      </article>

      <article class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
        </div>
        <h3 class="fg-title">跨机器组网</h3>
        <p class="fg-desc">Hub 起在公网或局域网，其他机器 anet login --hub 加入，SSE 实时双向。</p>
      </article>

      <article class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1M21 4v5h-5"/></svg>
        </div>
        <h3 class="fg-title">自动迁移</h3>
        <p class="fg-desc">anet doctor --fix 一键检测 + 修复老 V2 配置，session 历史不丢。</p>
      </article>

      <article class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg>
        </div>
        <h3 class="fg-title">本地优先</h3>
        <p class="fg-desc">SQLite 跑你机器上，可换 PostgreSQL，可选 ntok_ 网络隔离，零遥测。</p>
      </article>
    </div>
  </section>
</template>
