<script setup lang="ts">
// 首页主截图:桌面端聊天页(左侧节点列表含「新消息」分组)。
// 截图来源:agent-network-app origin/main 的 web 导出 + 模拟 __TAURI_INTERNALS__,
// 连一个一次性 hub(独立 HOME、独立端口),节点名全部是演示用占位名。
import ThemedShot from './ThemedShot.vue'
const props = defineProps<{ lang: 'zh' | 'en' }>()
const t = props.lang === 'en'
  ? {
      alt: 'Agent Network desktop app: the node list on the left, with nodes that have unread replies grouped under 新消息 (New messages); a conversation with demo-node on the right',
      note: 'Real app, demo data — node names are placeholders.',
    }
  : {
      alt: 'Agent Network 桌面端：左侧节点列表，有未读回复的节点浮在最上方的「新消息」分组；右侧是和 demo-node 的对话',
      note: '真实界面，演示数据 —— 节点名都是占位名。',
    }
</script>

<template>
  <div class="home-showcase">
    <div class="home-frame">
      <ThemedShot name="app-chat" :alt="t.alt" />
    </div>
    <p class="home-showcase-note">{{ t.note }}</p>
  </div>
</template>
