<script setup lang="ts">
// 英雄区右侧:一张真实的桌面端截图(0.2.84,深色主题,聊天界面),套一层最简 macOS 窗口边框。
// 2026-09-23 v3(Vincent:「这个地方实在太丑了」):去掉之前编造的「commhub」终端流水和
// 「120+ 在线节点 / 4 种模型运行时 / 3 端」这类站不住的数字 —— 首页只放真东西。
// 截图来源:agent-network-app 0.2.84 web 导出 + 一次性 hub 上的示例会话(见 docs/tests 记录),
// 窗口边框用 CSS 画在 <img> 外面,不烙进 PNG,换主题/换图不用重做。
import { withBase } from 'vitepress'
const props = defineProps<{ lang?: 'zh' | 'en' }>()
const src = withBase('/hero/desktop-chat-dark.png')
const alt = props.lang === 'en'
  ? 'Agent Network desktop app, dark theme: agent list on the left, a conversation with an agent on the right'
  : 'Agent Network 桌面端(深色主题):左侧是 Agent 列表,右侧是与一个 Agent 的对话'
const title = props.lang === 'en' ? 'Agent Network' : 'Agent Network'
</script>

<template>
  <div class="hero-shot" aria-label="desktop app screenshot">
    <div class="hero-shot-bar" aria-hidden="true">
      <span class="dot dot-r"></span><span class="dot dot-y"></span><span class="dot dot-g"></span>
      <span class="hero-shot-title">{{ title }}</span>
    </div>
    <img class="hero-shot-img" :src="src" :alt="alt" width="1120" height="720" decoding="async" fetchpriority="high" />
  </div>
</template>
