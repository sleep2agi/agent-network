<script setup lang="ts">
// 一张截图,两份文件:浅色页面配浅色截图,深色页面配深色截图(Vincent 2026-09-25:
// 「浅色背景为什么要放一张深色截图」)。用 VitePress 的 `.dark` 类切换,而不是
// <picture media="(prefers-color-scheme)"> —— 后者只认系统设置,不跟右上角的主题开关走。
// 被 display:none 的那张配 loading="lazy",浏览器不会去下载它。
import { withBase } from 'vitepress'
defineProps<{ name: string; alt: string; width?: number; height?: number }>()
</script>

<template>
  <figure class="themed-shot">
    <img class="themed-shot-light" :src="withBase(`/hero/${name}-light.webp`)" :alt="alt" :width="width ?? 1600" :height="height ?? 1000" loading="lazy" decoding="async" />
    <img class="themed-shot-dark" :src="withBase(`/hero/${name}-dark.webp`)" :alt="alt" :width="width ?? 1600" :height="height ?? 1000" loading="lazy" decoding="async" />
  </figure>
</template>
