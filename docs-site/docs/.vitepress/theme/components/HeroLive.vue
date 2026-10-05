<script setup lang="ts">
// 英雄区右侧:一张真实的桌面端截图(0.2.209 晴蓝主题,聊天界面),套一层最简 macOS 窗口边框。
// 2026-09-23 v3(Vincent:「这个地方实在太丑了」):去掉之前编造的「commhub」终端流水和
// 「120+ 在线节点 / 4 种模型运行时 / 3 端」这类站不住的数字 —— 首页只放真东西。
// 截图来源(2026-10-05 #565):agent-network-app 0.2.209 web 导出 + 仓内 layout-sweep 页内桩(无 hub),
// 示例数据全是通用占位别名(research-agent / code-reviewer / ops-bot …),1120×720 @2x,
// 窗口边框用 CSS 画在 <img> 外面,不烙进 PNG,换主题/换图不用重做。
// 2026-10-05 #569(Vincent:「浅色背景…首页里面选了一张黑色的图,那感觉是不是也有点奇怪？」):
// 截图跟随站点主题 —— 浅色站点放浅色截图,深色放深色。两张同尺寸 <img> 都渲染进 SSR,
// 由 VitePress 切到 <html> 上的 .dark 类用 CSS 决定显示哪张:首帧就对(.dark 由 VitePress 在
// <head> 内联脚本里先于渲染设好),不闪、不跳布局,也不靠 JS 判断。<picture media=prefers-color-scheme>
// 跟不上手动切换开关,所以不用。两张都 loading="lazy":display:none 的那张浏览器不会去取,
// 只在切换主题时才拉。窗口标题栏也跟着变浅(全局样式在 custom.css,这里只做浅色覆盖)。
import { withBase } from 'vitepress'
const props = defineProps<{ lang?: 'zh' | 'en' }>()
const srcDark = withBase('/hero/desktop-chat-dark.png')
const srcLight = withBase('/hero/desktop-chat-light.png')
const en = props.lang === 'en'
const altDark = en
  ? 'Agent Network desktop app, dark theme: agent list on the left, a conversation with an agent on the right'
  : 'Agent Network 桌面端(深色主题):左侧是 Agent 列表,右侧是与一个 Agent 的对话'
const altLight = en
  ? 'Agent Network desktop app, light theme: agent list on the left, a conversation with an agent on the right'
  : 'Agent Network 桌面端(浅色主题):左侧是 Agent 列表,右侧是与一个 Agent 的对话'
const title = 'Agent Network'
</script>

<template>
  <div class="hero-shot" aria-label="desktop app screenshot">
    <div class="hero-shot-bar" aria-hidden="true">
      <span class="dot dot-r"></span><span class="dot dot-y"></span><span class="dot dot-g"></span>
      <span class="hero-shot-title">{{ title }}</span>
    </div>
    <img class="hero-shot-img hero-shot-img--light" :src="srcLight" :alt="altLight" width="1120" height="720" loading="lazy" decoding="async" fetchpriority="high" />
    <img class="hero-shot-img hero-shot-img--dark" :src="srcDark" :alt="altDark" width="1120" height="720" loading="lazy" decoding="async" fetchpriority="high" />
  </div>
</template>

<style scoped>
/* 只显示与当前站点主题一致的那张;另一张 display:none(lazy 下不会被请求) */
html.dark .hero-shot-img--light { display: none; }
html:not(.dark) .hero-shot-img--dark { display: none; }
/* 浅色主题:窗口框和标题栏跟着变浅,不再是深色框套浅色截图 */
html:not(.dark) .hero-shot {
  background: #f5f6f8;
  border-color: rgba(15, 23, 42, 0.1);
  box-shadow:
    0 40px 90px -36px rgba(37, 99, 217, 0.28),
    0 24px 48px -24px rgba(15, 23, 42, 0.25);
}
html:not(.dark) .hero-shot-bar {
  background: linear-gradient(180deg, #f3f4f6, #e9ebef);
  border-bottom-color: rgba(15, 23, 42, 0.08);
}
html:not(.dark) .hero-shot-title { color: #6b7280; }
</style>
