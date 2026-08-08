<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

type Skill = {
  slug: string
  name: string
  description: string
  version: string
  license: string
  publisher: { name: string; url?: string }
  tags: string[]
  published_at: string
  content_sha256: string
  content_url: string
}

const props = withDefaults(defineProps<{ lang?: 'zh' | 'en' }>(), { lang: 'zh' })
const skills = ref<Skill[]>([])
const query = ref('')
const loading = ref(true)
const error = ref('')
const selected = ref<Skill | null>(null)
const content = ref('')
const contentLoading = ref(false)
const copied = ref(false)

const t = computed(() => props.lang === 'en' ? {
  search: 'Search skills, publishers, or tags…', empty: 'No public skills match this search.',
  view: 'View SKILL.md', download: 'Download', copy: 'Copy', copied: 'Copied', close: 'Close',
  loadError: 'The public SkillHub catalog is temporarily unavailable.',
  contentError: 'This skill could not be loaded.', reviewed: 'Publicly reviewed',
} : {
  search: '搜索 Skill、发布者或标签…', empty: '没有匹配的公共 Skill。',
  view: '查看 SKILL.md', download: '下载', copy: '复制', copied: '已复制', close: '关闭',
  loadError: '公共 SkillHub 目录暂时不可用。', contentError: '无法读取这份 Skill。',
  reviewed: '已通过公共审核',
})

const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return skills.value
  return skills.value.filter(skill => [
    skill.slug, skill.name, skill.description, skill.publisher.name, ...skill.tags,
  ].some(value => value.toLocaleLowerCase().includes(needle)))
})

onMounted(async () => {
  try {
    const response = await fetch(withBase('/skillhub/catalog.json'), { cache: 'no-store' })
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`)
    const payload = await response.json()
    if (payload?.schema_version !== 1 || !Array.isArray(payload.skills)) throw new Error('invalid catalog')
    skills.value = payload.skills
  } catch (cause) {
    console.error(cause)
    error.value = t.value.loadError
  } finally {
    loading.value = false
  }
})

async function openSkill(skill: Skill) {
  selected.value = skill
  content.value = ''
  copied.value = false
  contentLoading.value = true
  try {
    const response = await fetch(withBase(skill.content_url), { cache: 'no-store' })
    if (!response.ok) throw new Error(`content HTTP ${response.status}`)
    content.value = await response.text()
  } catch (cause) {
    console.error(cause)
    content.value = t.value.contentError
  } finally {
    contentLoading.value = false
  }
}

async function copyContent() {
  if (!content.value) return
  await navigator.clipboard.writeText(content.value)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1600)
}
</script>

<template>
  <section class="public-skillhub" aria-label="Public SkillHub catalog">
    <div class="skillhub-toolbar">
      <input v-model="query" type="search" :placeholder="t.search" :aria-label="t.search">
      <span class="skill-count">{{ filtered.length }} / {{ skills.length }}</span>
    </div>

    <p v-if="error" class="skillhub-message skillhub-error">{{ error }}</p>
    <div v-else-if="loading" class="skill-grid" aria-busy="true">
      <div v-for="index in 3" :key="index" class="skill-card skill-skeleton" />
    </div>
    <p v-else-if="filtered.length === 0" class="skillhub-message">{{ t.empty }}</p>
    <div v-else class="skill-grid">
      <article v-for="skill in filtered" :key="`${skill.slug}@${skill.version}`" class="skill-card">
        <div class="skill-card-heading">
          <div>
            <h2>{{ skill.name }}</h2>
            <code>{{ skill.slug }}@{{ skill.version }}</code>
          </div>
          <span class="review-badge">{{ t.reviewed }}</span>
        </div>
        <p>{{ skill.description }}</p>
        <div class="skill-tags">
          <span v-for="tag in skill.tags" :key="tag">{{ tag }}</span>
        </div>
        <dl>
          <div><dt>Publisher</dt><dd><a v-if="skill.publisher.url" :href="skill.publisher.url" rel="noopener noreferrer">{{ skill.publisher.name }}</a><span v-else>{{ skill.publisher.name }}</span></dd></div>
          <div><dt>License</dt><dd>{{ skill.license }}</dd></div>
          <div><dt>SHA-256</dt><dd><code>{{ skill.content_sha256.slice(0, 12) }}</code></dd></div>
        </dl>
        <button type="button" class="skill-primary" @click="openSkill(skill)">{{ t.view }}</button>
      </article>
    </div>

    <div v-if="selected" class="skill-modal-backdrop" @mousedown.self="selected = null">
      <section class="skill-modal" role="dialog" aria-modal="true" :aria-label="selected.name">
        <header>
          <div><h2>{{ selected.name }}</h2><code>{{ selected.slug }}@{{ selected.version }}</code></div>
          <button type="button" class="skill-close" @click="selected = null">{{ t.close }}</button>
        </header>
        <p v-if="contentLoading" class="skillhub-message" aria-busy="true">…</p>
        <pre v-else>{{ content }}</pre>
        <footer>
          <a :href="withBase(selected.content_url)" download>{{ t.download }}</a>
          <button type="button" @click="copyContent">{{ copied ? t.copied : t.copy }}</button>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.public-skillhub { margin-top: 28px; }
.skillhub-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.skillhub-toolbar input { flex: 1; min-width: 0; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); padding: 11px 14px; font: inherit; }
.skillhub-toolbar input:focus { border-color: var(--vp-c-brand-1); outline: 2px solid var(--vp-c-brand-soft); }
.skill-count { color: var(--vp-c-text-2); font-size: 13px; white-space: nowrap; }
.skill-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.skill-card { display: flex; min-height: 280px; flex-direction: column; gap: 14px; border: 1px solid var(--vp-c-divider); border-radius: 16px; background: var(--vp-c-bg-soft); padding: 18px; }
.skill-card-heading { display: flex; align-items: flex-start; gap: 12px; }
.skill-card-heading > div { min-width: 0; flex: 1; }
.skill-card h2, .skill-modal h2 { margin: 0; border: 0; padding: 0; font-size: 18px; line-height: 1.35; }
.skill-card code, .skill-modal header code { color: var(--vp-c-brand-1); font-size: 12px; }
.skill-card > p { margin: 0; color: var(--vp-c-text-2); font-size: 14px; line-height: 1.6; }
.review-badge { flex: none; border-radius: 999px; background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); padding: 4px 8px; font-size: 10px; }
.skill-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.skill-tags span { border: 1px solid var(--vp-c-divider); border-radius: 999px; padding: 3px 7px; color: var(--vp-c-text-2); font-size: 11px; }
.skill-card dl { display: grid; gap: 5px; margin: auto 0 0; font-size: 12px; }
.skill-card dl div { display: grid; grid-template-columns: 72px 1fr; gap: 8px; min-width: 0; }
.skill-card dt { color: var(--vp-c-text-3); }
.skill-card dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-primary, .skill-modal footer button, .skill-modal footer a { border: 0; border-radius: 10px; background: var(--vp-c-brand-1); color: var(--vp-c-bg); padding: 9px 12px; font: inherit; font-size: 13px; font-weight: 600; text-align: center; cursor: pointer; text-decoration: none; }
.skillhub-message { border: 1px dashed var(--vp-c-divider); border-radius: 14px; padding: 28px; color: var(--vp-c-text-2); text-align: center; }
.skillhub-error { border-style: solid; color: var(--vp-c-danger-1); }
.skill-skeleton { min-height: 280px; animation: skill-pulse 1.4s ease-in-out infinite; }
.skill-modal-backdrop { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--vp-c-bg) 76%, transparent); backdrop-filter: blur(8px); }
.skill-modal { display: flex; width: min(880px, 100%); max-height: 88vh; flex-direction: column; border: 1px solid var(--vp-c-divider); border-radius: 18px; background: var(--vp-c-bg); box-shadow: var(--vp-shadow-5); padding: 20px; }
.skill-modal header { display: flex; align-items: flex-start; gap: 12px; }
.skill-modal header > div { min-width: 0; flex: 1; }
.skill-close { border: 1px solid var(--vp-c-divider); border-radius: 8px; background: transparent; color: var(--vp-c-text-2); padding: 6px 9px; cursor: pointer; }
.skill-modal pre { overflow: auto; flex: 1; margin: 18px 0; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-code-block-bg); padding: 16px; color: var(--vp-code-block-color); font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
.skill-modal footer { display: flex; justify-content: flex-end; gap: 8px; }
@keyframes skill-pulse { 50% { opacity: .45; } }
@media (max-width: 720px) {
  .skill-grid { grid-template-columns: 1fr; }
  .skill-modal-backdrop { align-items: end; padding: 0; }
  .skill-modal { width: 100%; max-height: 92vh; border-radius: 18px 18px 0 0; }
}
</style>

