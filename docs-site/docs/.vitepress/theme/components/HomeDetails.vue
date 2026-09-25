<script setup lang="ts">
import ThemedShot from './ThemedShot.vue'
const props = defineProps<{ lang: 'zh' | 'en' }>()
const rows = props.lang === 'en'
  ? [
      {
        shot: 'app-rules',
        eyebrow: 'Rules file',
        title: 'Read every node’s CLAUDE.md or AGENTS.md',
        body: 'Each node reports the rules file for its own runtime. Read it rendered, switch to edit, or open it full screen with an outline. The node’s skills are one tab away.',
        alt: 'Node page for demo-node: the rules file section showing CLAUDE.md rendered as headings and bullet lists, with read / edit tabs',
      },
      {
        shot: 'app-files',
        eyebrow: 'Project folder',
        title: 'Browse the working directory without SSH',
        body: 'Walk the node’s folders and open text files from the desktop or phone. Credential files such as .env are listed by name only; their contents are never shown.',
        alt: 'Node page for demo-node: the project folder section listing docs, src, tests, CLAUDE.md, README.md and a locked .env entry',
      },
    ]
  : [
      {
        shot: 'app-rules',
        eyebrow: '规则文件',
        title: '直接读每个节点的 CLAUDE.md / AGENTS.md',
        body: '节点按自己的运行时回报规则文件。可以渲染阅读、切到编辑，也能全屏带大纲看；节点装了哪些技能，旁边一栏就能看到。',
        alt: 'demo-node 的节点页：规则文件分区，CLAUDE.md 渲染成标题和列表，上方有阅读 / 编辑切换',
      },
      {
        shot: 'app-files',
        eyebrow: '项目文件夹',
        title: '看节点的工作目录，不用 SSH 上去',
        body: '在桌面端或手机上浏览节点的目录、打开文本文件。.env 这类凭据文件只显示名字，不显示内容。',
        alt: 'demo-node 的节点页：项目文件夹分区，列出 docs、src、tests、CLAUDE.md、README.md，以及加锁的 .env',
      },
    ]
</script>

<template>
  <section class="home-details">
    <article v-for="(row, i) in rows" :key="row.shot" class="home-detail" :class="{ 'is-flipped': i % 2 === 1 }">
      <div class="home-detail-copy">
        <span class="eyebrow">{{ row.eyebrow }}</span>
        <h2>{{ row.title }}</h2>
        <p>{{ row.body }}</p>
      </div>
      <div class="home-frame">
        <ThemedShot :name="row.shot" :alt="row.alt" :width="1200" :height="1034" />
      </div>
    </article>
  </section>
</template>
