<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ lang: 'zh' | 'en' }>()
const cmd = 'curl -fsSL https://anet.sh/install.sh | sh'
const copied = ref(false)
const t = props.lang === 'en'
  ? { label: 'Or install the anet CLI', copy: 'Copy', done: 'Copied' }
  : { label: '或者安装 anet CLI', copy: '复制', done: '已复制' }
async function copy() {
  try {
    await navigator.clipboard.writeText(cmd)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1600)
  } catch { /* clipboard blocked: the command stays selectable */ }
}
</script>

<template>
  <div class="hero-cli">
    <span class="hero-cli-label">{{ t.label }}</span>
    <div class="hero-cli-box">
      <code><span class="hero-cli-prompt" aria-hidden="true">$</span>{{ cmd }}</code>
      <button type="button" class="hero-cli-copy" @click="copy" :aria-label="`${t.copy}: ${cmd}`">
        <span aria-live="polite">{{ copied ? t.done : t.copy }}</span>
      </button>
    </div>
  </div>
</template>
