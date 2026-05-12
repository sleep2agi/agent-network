<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vitepress'

const route = useRoute()
const isEn = computed(() => route.path.startsWith('/en/'))
const href = computed(() => (isEn.value ? '/en/deploy/production' : '/deploy/production'))
const aria = computed(() =>
  isEn.value
    ? 'Production deployment / public-internet safety guide'
    : '生产部署 / 公网部署安全指南'
)
const pill = computed(() => (isEn.value ? 'Public preview' : '公测'))
const codePath = computed(() => (isEn.value ? '/en/deploy/production' : '/deploy/production'))
</script>

<template>
  <a class="hero-notice" :href="href" :aria-label="aria">
    <span class="hero-notice-pill">
      <span class="hero-notice-pulse"></span>
      {{ pill }}
    </span>
    <span class="hero-notice-text" v-if="isEn">
      Used daily by the maintainer for 2 months · before public-internet deploy read the <code class="hero-notice-code">{{ codePath }}</code> safety guide
    </span>
    <span class="hero-notice-text" v-else>
      作者已自用 2 个月 · 公网部署前看 <code class="hero-notice-code">{{ codePath }}</code> 安全指南
    </span>
    <span class="hero-notice-arrow" aria-hidden="true">↗</span>
  </a>
</template>
