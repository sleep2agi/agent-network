<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vitepress'

const route = useRoute()
const isEn = computed(() => route.path.startsWith('/en/'))
const copyLabel = computed(() => (isEn.value ? 'Copy' : '复制'))
const copiedLabel = computed(() => (isEn.value ? '✓ Copied' : '✓ 已复制'))
const comingSoon = computed(() => (isEn.value ? '(coming soon)' : '(即将上线)'))

const cmd = 'npm install -g @sleep2agi/agent-network'
const copied = ref(false)
let timer: any = null

async function copy() {
  try {
    await navigator.clipboard.writeText(cmd)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = cmd
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), 1600)
}
</script>

<template>
  <div class="install-cmd">
    <div class="install-cmd-head">
      <span class="install-cmd-dot install-cmd-dot-r"></span>
      <span class="install-cmd-dot install-cmd-dot-y"></span>
      <span class="install-cmd-dot install-cmd-dot-g"></span>
      <span class="install-cmd-title">~/install</span>
      <button
        class="install-cmd-copy"
        :class="{ 'is-copied': copied }"
        @click="copy"
        :aria-label="copied ? 'Copied' : 'Copy install command'"
      >
        <span v-if="!copied">{{ copyLabel }}</span>
        <span v-else>{{ copiedLabel }}</span>
      </button>
    </div>
    <div class="install-cmd-body">
      <div class="install-cmd-line is-comment">
        <span class="install-cmd-prompt is-comment-prompt">#</span>
        <code class="install-cmd-text"
          ><span class="ic-cmt">curl -fsSL https://anet.sh/install.sh | sh  &nbsp;</span><span class="ic-todo">{{ comingSoon }}</span></code
        >
      </div>
      <div class="install-cmd-line">
        <span class="install-cmd-prompt">$</span>
        <code class="install-cmd-text"
          ><span class="ic-cmd">npm</span> <span class="ic-arg">install</span> <span class="ic-flag">-g</span> <span class="ic-pkg">@sleep2agi/agent-network</span></code
        >
      </div>
    </div>
  </div>
</template>
