<script setup lang="ts">
// Each card carries: tone (color theme), icon, title, oneLiner, and a slot-style mini illustration
</script>

<template>
  <section class="fg">
    <div class="fg-grid">
      <!-- 1. 一行装完 -->
      <article class="fg-card" data-tone="emerald">
        <div class="fg-stripe"></div>
        <div class="fg-icon">🚀</div>
        <h3 class="fg-title">一行装完</h3>
        <p class="fg-desc">npm 一条命令把 Hub + Dashboard + Agent 全部就位。</p>
        <div class="fg-mini fg-mini-term">
          <div class="fg-mini-head">
            <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
          </div>
          <div class="fg-mini-body">
            <span class="prompt">$</span> <span class="cmd">npm</span> i -g <span class="pkg">@sleep2agi/agent-network</span>
          </div>
        </div>
      </article>

      <!-- 2. 三种 Runtime -->
      <article class="fg-card" data-tone="brand">
        <div class="fg-stripe"></div>
        <div class="fg-icon">🧠</div>
        <h3 class="fg-title">三种 Runtime</h3>
        <p class="fg-desc">同一 Hub 跑三种 Agent 内核，按场景挑。</p>
        <div class="fg-mini fg-mini-chips">
          <span class="rt-chip rt-1">⌨ Claude Code CLI</span>
          <span class="rt-chip rt-2">◆ Claude Agent SDK</span>
          <span class="rt-chip rt-3">◇ Codex SDK</span>
        </div>
      </article>

      <!-- 3. 一键 Demo -->
      <article class="fg-card" data-tone="orange">
        <div class="fg-stripe"></div>
        <div class="fg-icon">🎙️</div>
        <h3 class="fg-title">一键 Demo</h3>
        <p class="fg-desc">6 角色辩论赛 / 4 角色社媒工厂，一行命令 10 分钟跑完。</p>
        <div class="fg-mini fg-mini-term">
          <div class="fg-mini-head">
            <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
          </div>
          <div class="fg-mini-body">
            <span class="prompt">$</span> <span class="cmd">anet</span> demo <span class="arg">debate</span>
          </div>
        </div>
      </article>

      <!-- 4. 跨机器组网 -->
      <article class="fg-card" data-tone="cyan">
        <div class="fg-stripe"></div>
        <div class="fg-icon">🌐</div>
        <h3 class="fg-title">跨机器组网</h3>
        <p class="fg-desc">Hub 绑 0.0.0.0，其他机器 anet login --hub 加入，SSE 实时双向。</p>
        <svg class="fg-mini fg-mini-mesh" viewBox="0 0 200 60" aria-hidden="true">
          <line x1="40" y1="30" x2="100" y2="15" />
          <line x1="40" y1="30" x2="100" y2="45" />
          <line x1="100" y1="15" x2="160" y2="30" />
          <line x1="100" y1="45" x2="160" y2="30" />
          <line x1="100" y1="15" x2="100" y2="45" />
          <circle cx="40" cy="30" r="6" />
          <circle cx="100" cy="15" r="6" />
          <circle cx="100" cy="45" r="6" />
          <circle cx="160" cy="30" r="6" />
        </svg>
      </article>

      <!-- 5. 自动迁移 -->
      <article class="fg-card" data-tone="purple">
        <div class="fg-stripe"></div>
        <div class="fg-icon">🩺</div>
        <h3 class="fg-title">自动迁移</h3>
        <p class="fg-desc">老 V2 配置一键检测 + 修复，session 历史不丢。</p>
        <div class="fg-mini fg-mini-diff">
          <div class="diff-line minus"><span class="sigil">-</span> alias: <span class="str">"指挥室"</span></div>
          <div class="diff-line plus"><span class="sigil">+</span> name:  <span class="str">"指挥室"</span></div>
          <div class="diff-line plus"><span class="sigil">+</span> token: <span class="str">"ntok_..."</span></div>
        </div>
      </article>

      <!-- 6. 本地优先 -->
      <article class="fg-card" data-tone="pink">
        <div class="fg-stripe"></div>
        <div class="fg-icon">🔒</div>
        <h3 class="fg-title">本地优先</h3>
        <p class="fg-desc">SQLite 跑你自己机器，可换 PostgreSQL，可选 ntok_ 网络隔离。</p>
        <div class="fg-mini fg-mini-stack">
          <span class="stack-row"><span class="kbd">SQLite</span><span class="muted">~/.commhub/commhub.db</span></span>
          <span class="stack-row"><span class="kbd">utok_</span><span class="muted">user-scoped</span></span>
          <span class="stack-row"><span class="kbd">ntok_</span><span class="muted">network-scoped</span></span>
        </div>
      </article>
    </div>
  </section>
</template>
