<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vitepress'

const route = useRoute()
const isEn = computed(() => route.path.startsWith('/en/'))

const features = computed(() =>
  isEn.value
    ? [
        {
          icon: 'arrow',
          title: 'One-line install',
          desc: 'A single `npm i -g` lands Hub + Dashboard + Agent — zero extra config.',
        },
        {
          icon: 'screen',
          title: 'Three runtimes',
          desc: 'Same Hub runs Claude Code CLI, Claude Agent SDK, and Codex SDK — pick per role.',
        },
        {
          icon: 'play',
          title: 'One-shot demos',
          desc: '`anet demo debate` 6-agent debate, `anet demo socialmedia` 4-agent content factory — done in ~10 minutes.',
        },
        {
          icon: 'globe',
          title: 'Cross-machine mesh',
          desc: 'Run Hub on public IP or LAN; other machines `anet login --hub` to join. SSE keeps it real-time both ways.',
        },
        {
          icon: 'refresh',
          title: 'Auto migration',
          desc: '`anet doctor --fix` one-shot detects and repairs legacy V2 configs — session history preserved.',
        },
        {
          icon: 'lock',
          title: 'Local-first',
          desc: 'SQLite runs on your machine. Optional `ntok_` network isolation. Zero telemetry.',
        },
      ]
    : [
        {
          icon: 'arrow',
          title: '一行装完',
          desc: 'npm i -g 一条命令把 Hub + Dashboard + Agent 三件套就位，零额外配置。',
        },
        {
          icon: 'screen',
          title: '三种 Runtime',
          desc: '同一 Hub 跑 Claude Code CLI、Claude Agent SDK、Codex SDK 三种内核，按角色挑。',
        },
        {
          icon: 'play',
          title: '一键 Demo',
          desc: 'anet demo debate 6 角色辩论赛、anet demo socialmedia 4 角色社媒工厂，10 分钟跑完。',
        },
        {
          icon: 'globe',
          title: '跨机器组网',
          desc: 'Hub 起在公网或局域网，其他机器 anet login --hub 加入，SSE 实时双向。',
        },
        {
          icon: 'refresh',
          title: '自动迁移',
          desc: 'anet doctor --fix 一键检测 + 修复老 V2 配置，session 历史不丢。',
        },
        {
          icon: 'lock',
          title: '本地优先',
          desc: 'SQLite 跑你机器上，可选 ntok_ 网络隔离，零遥测。',
        },
      ]
)
</script>

<template>
  <section class="fg">
    <div class="fg-grid">
      <article v-for="(f, i) in features" :key="i" class="fg-card">
        <div class="fg-icon" aria-hidden="true">
          <svg v-if="f.icon === 'arrow'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          <svg v-else-if="f.icon === 'screen'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8M12 18v2"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="11" r="1"/><circle cx="16" cy="11" r="1"/></svg>
          <svg v-else-if="f.icon === 'play'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          <svg v-else-if="f.icon === 'globe'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
          <svg v-else-if="f.icon === 'refresh'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1M21 4v5h-5"/></svg>
          <svg v-else-if="f.icon === 'lock'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg>
        </div>
        <h3 class="fg-title">{{ f.title }}</h3>
        <p class="fg-desc">{{ f.desc }}</p>
      </article>
    </div>
  </section>
</template>
