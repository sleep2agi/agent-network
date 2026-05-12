<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vitepress'

const route = useRoute()
const isEn = computed(() => route.path.startsWith('/en/'))

const labels = computed(() =>
  isEn.value
    ? { runtimes: 'Runtimes', providers: 'LLM providers' }
    : { runtimes: '支持 Runtime', providers: '兼容 LLM' }
)

const runtimes = [
  { name: 'Claude Code CLI', logo: 'claude', id: 'claude-code-cli', mono: false },
  { name: 'Claude Agent SDK', logo: 'anthropic', id: 'claude-agent-sdk', mono: true, monoColor: '#D97757' },
  { name: 'Codex SDK', logo: 'openai', id: 'codex-sdk', mono: true, monoColor: '#10A37F' },
]

const providers = computed(() =>
  isEn.value
    ? [
        { name: 'Claude', logo: 'claude', mono: false },
        { name: 'Codex / GPT', logo: 'openai', mono: true, monoColor: '#10A37F' },
        { name: 'MiniMax', logo: 'minimax', mono: false },
        { name: 'DeepSeek', logo: 'deepseek', mono: false },
        { name: 'GLM', logo: 'zhipu', mono: false },
        { name: 'Kimi', logo: 'kimi', mono: false },
        { name: 'InternLM', logo: 'internlm', mono: false },
      ]
    : [
        { name: 'Claude', logo: 'claude', mono: false },
        { name: 'Codex / GPT', logo: 'openai', mono: true, monoColor: '#10A37F' },
        { name: 'MiniMax', logo: 'minimax', mono: false },
        { name: 'DeepSeek', logo: 'deepseek', mono: false },
        { name: 'GLM', logo: 'zhipu', mono: false },
        { name: 'Kimi', logo: 'kimi', mono: false },
        { name: '书生 Intern', logo: 'internlm', mono: false },
      ]
)
</script>

<template>
  <div class="hero-badges">
    <div class="hero-badges-row">
      <span class="hero-badges-label">{{ labels.runtimes }}</span>
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
      <span class="hero-badges-label">{{ labels.providers }}</span>
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
