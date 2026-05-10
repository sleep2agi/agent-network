<script setup lang="ts">
const runtimes = [
  { name: 'Claude Code CLI', logo: 'claude', id: 'claude-code-cli', mono: false },
  { name: 'Claude Agent SDK', logo: 'anthropic', id: 'claude-agent-sdk', mono: true, monoColor: '#D97757' },
  { name: 'Codex SDK', logo: 'openai', id: 'codex-sdk', mono: true, monoColor: '#10A37F' },
]

const providers = [
  { name: 'Claude', logo: 'claude', mono: false },
  { name: 'Codex / GPT', logo: 'openai', mono: true, monoColor: '#10A37F' },
  { name: 'MiniMax', logo: 'minimax', mono: false },
  { name: 'DeepSeek', logo: 'deepseek', mono: false },
  { name: 'GLM', logo: 'zhipu', mono: false },
  { name: 'Kimi', logo: 'kimi', mono: false },
  { name: '书生 Intern', logo: 'internlm', mono: false },
]
</script>

<template>
  <div class="hero-badges">
    <div class="hero-badges-row">
      <span class="hero-badges-label">支持 Runtime</span>
      <div class="hero-badges-list">
        <span
          v-for="r in runtimes"
          :key="r.id"
          class="hero-badge runtime-badge"
          :title="r.id"
        >
          <span
            class="hero-badge-logo"
            :class="{ 'is-mono': r.mono }"
            :style="r.mono ? { color: r.monoColor } : null"
          >
            <img :src="`/logos/${r.logo}.svg`" :alt="r.name" loading="lazy" />
          </span>
          <span class="hero-badge-name">{{ r.name }}</span>
        </span>
      </div>
    </div>
    <div class="hero-badges-row">
      <span class="hero-badges-label">兼容 LLM</span>
      <div class="hero-badges-list">
        <span
          v-for="p in providers"
          :key="p.name"
          class="hero-badge"
          :title="p.name"
        >
          <span
            class="hero-badge-logo"
            :class="{ 'is-mono': p.mono }"
            :style="p.mono ? { color: p.monoColor } : null"
          >
            <img :src="`/logos/${p.logo}.svg`" :alt="p.name" loading="lazy" />
          </span>
          <span class="hero-badge-name">{{ p.name }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
