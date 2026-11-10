<script setup lang="ts">
// "One Hub, seven runtimes": the runtime names come from the support matrix
// (guide/support-matrix). Nothing here is live data; it is a diagram.
import { computed } from 'vue'
const props = defineProps<{ lang?: string }>()
const en = computed(() => (props.lang ?? 'zh') === 'en')
const runtimes = ['claude-agent-sdk', 'claude-code-cli', 'codex-sdk', 'codex-app-server', 'grok-build-acp', 'grok-build-cli', 'opencode-cli']
const W = 1100, H = 420, cx = W / 2, cy = H / 2
const nodes = runtimes.map((name, i) => {
  const a = Math.PI + 0.2 + (i * 2 * Math.PI) / runtimes.length
  return { name, x: cx + Math.cos(a) * 400, y: cy + Math.sin(a) * 150, delay: (i * 0.37).toFixed(2) }
})
</script>

<template>
  <section class="home-runtimes" aria-labelledby="home-runtimes-title">
    <div class="home-runtimes-heading">
      <span class="eyebrow">ONE HUB</span>
      <h2 id="home-runtimes-title">{{ en ? 'Seven runtimes on one network' : '7 种 Runtime，连在同一张网上' }}</h2>
      <p>{{ en ? 'Claude, Codex, Grok and OpenCode nodes register with the same Hub, so they can message each other and share tasks.' : 'Claude、Codex、Grok、OpenCode 节点注册到同一个 Hub，彼此能发消息、接同一批任务。' }}
        <a :href="en ? '/en/guide/support-matrix' : '/guide/support-matrix'">{{ en ? 'Support matrix →' : '支持矩阵 →' }}</a></p>
    </div>
    <div class="home-runtimes-stage">
      <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="en ? 'Diagram: seven runtimes connected to one Hub' : '示意图：七种 Runtime 连到同一个 Hub'">
        <defs>
          <radialGradient id="hr-hub" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#3b7be6" /><stop offset="1" stop-color="#1554be" /></radialGradient>
          <filter id="hr-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <g v-for="n in nodes" :key="n.name">
          <line class="hr-link" :x1="cx" :y1="cy" :x2="n.x" :y2="n.y" />
          <circle class="hr-packet" r="4">
            <animateMotion :dur="'2.6s'" :begin="`${n.delay}s`" repeatCount="indefinite" :path="`M${cx},${cy} L${n.x},${n.y}`" />
          </circle>
          <circle class="hr-packet hr-packet-back" r="3">
            <animateMotion :dur="'3.4s'" :begin="`${n.delay}s`" repeatCount="indefinite" :path="`M${n.x},${n.y} L${cx},${cy}`" />
          </circle>
        </g>
        <circle class="hr-hub-ring" :cx="cx" :cy="cy" r="64" />
        <circle :cx="cx" :cy="cy" r="52" fill="url(#hr-hub)" filter="url(#hr-glow)" />
        <text class="hr-hub-label" :x="cx" :y="cy + 7" text-anchor="middle">Hub</text>
        <g class="hr-chip-g" v-for="n in nodes" :key="n.name + '-chip'" :transform="`translate(${n.x},${n.y})`">
          <rect class="hr-chip" :x="-n.name.length * 5.2 - 16" y="-19" :width="n.name.length * 10.4 + 32" height="38" rx="10" />
          <text class="hr-chip-label" y="5" text-anchor="middle">{{ n.name }}</text>
        </g>
      </svg>
      <ul class="hr-list"><li v-for="n in nodes" :key="n.name + '-li'">{{ n.name }}</li></ul>
    </div>
  </section>
</template>
