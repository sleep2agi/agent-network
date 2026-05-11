<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const REPO = 'sleep2agi/agent-network'
const MIN_LEN = 5

const visible = ref(false)
const top = ref(0)
const left = ref(0)
const label = ref('📝 反馈此段（修改建议）')
const cachedSelectedText = ref('')
const cachedHeadingAnchor = ref('')
const cachedSourceFile = ref('')
const cachedSourceLine = ref(0)

function isEnLocale() {
  if (typeof window === 'undefined') return false
  return window.location.pathname.startsWith('/en/')
}

function isArchivePath() {
  if (typeof window === 'undefined') return false
  // skip archived versions like /v0.8.0/
  return /^\/v\d+\.\d+\.\d+\//.test(window.location.pathname)
}

function findArticleContainer(node: Node | null): HTMLElement | null {
  let cur: Node | null = node
  while (cur && cur.nodeType !== 1) cur = cur.parentNode
  let el = cur as HTMLElement | null
  while (el) {
    // VitePress article content lives inside .vp-doc / main
    if (el.classList?.contains('vp-doc')) return el
    if (el.tagName === 'MAIN') return el
    el = el.parentElement
  }
  return null
}

function isInsideNavOrSidebar(node: Node | null): boolean {
  let cur: Node | null = node
  while (cur && cur.nodeType !== 1) cur = cur.parentNode
  let el = cur as HTMLElement | null
  while (el) {
    const cls = el.classList
    if (cls) {
      if (
        cls.contains('VPNav') ||
        cls.contains('VPSidebar') ||
        cls.contains('VPLocalNav') ||
        cls.contains('VPNavBar') ||
        cls.contains('aside') ||
        cls.contains('VPDocAside')
      ) {
        return true
      }
    }
    if (el.tagName === 'NAV' || el.tagName === 'ASIDE' || el.tagName === 'HEADER') {
      return true
    }
    el = el.parentElement
  }
  return false
}

function findSourceLine(node: Node | null): number {
  let cur: Node | null = node
  while (cur && cur.nodeType !== 1) cur = cur.parentNode
  let el = cur as HTMLElement | null
  while (el) {
    const v = el.getAttribute && el.getAttribute('data-source-line')
    if (v) return parseInt(v, 10) || 0
    el = el.parentElement
  }
  return 0
}

function getSourceFile(): string {
  if (typeof window === 'undefined') return ''
  let p = window.location.pathname
  // /concepts/tokens → /concepts/tokens
  // /  → /index
  // /en/ → /en/index
  // strip trailing slash → add /index suffix (VitePress cleanUrls)
  if (p.endsWith('/')) p = p + 'index'
  // strip leading slash
  if (p.startsWith('/')) p = p.slice(1)
  return `docs-site/docs/${p}.md`
}

function findClosestHeading(node: Node | null): string {
  let cur: Node | null = node
  while (cur && cur.nodeType !== 1) cur = cur.parentNode
  let el = cur as HTMLElement | null
  // walk up to a block-level element, then look back through previous siblings
  while (el && !/^(P|LI|DIV|PRE|BLOCKQUOTE|TABLE|H[1-6]|UL|OL)$/.test(el.tagName)) {
    el = el.parentElement
  }
  if (!el) return ''
  // if itself is a heading
  if (/^H[1-6]$/.test(el.tagName)) {
    return el.id || ''
  }
  // walk previous siblings
  let sib: Element | null = el.previousElementSibling
  while (sib) {
    if (/^H[1-6]$/i.test(sib.tagName)) {
      return (sib as HTMLElement).id || ''
    }
    sib = sib.previousElementSibling
  }
  // walk up and try again
  let parent = el.parentElement
  while (parent) {
    let s: Element | null = parent.previousElementSibling
    while (s) {
      if (/^H[1-6]$/i.test(s.tagName)) {
        return (s as HTMLElement).id || ''
      }
      s = s.previousElementSibling
    }
    parent = parent.parentElement
  }
  return ''
}

function handleMouseUp(_e: MouseEvent) {
  if (typeof window === 'undefined') return
  if (isArchivePath()) {
    visible.value = false
    return
  }

  // defer so the selection is finalized
  setTimeout(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      visible.value = false
      return
    }
    const text = sel.toString().trim()
    if (text.length < MIN_LEN) {
      visible.value = false
      return
    }
    const range = sel.getRangeAt(0)
    const anchorNode = range.startContainer

    // must be inside .vp-doc
    if (!findArticleContainer(anchorNode)) {
      visible.value = false
      return
    }
    if (isInsideNavOrSidebar(anchorNode)) {
      visible.value = false
      return
    }

    const rect = range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      visible.value = false
      return
    }

    cachedSelectedText.value = text
    cachedHeadingAnchor.value = findClosestHeading(anchorNode)
    cachedSourceLine.value = findSourceLine(anchorNode)
    cachedSourceFile.value = getSourceFile()
    label.value = isEnLocale() ? '📝 Suggest edit' : '📝 反馈此段（修改建议）'

    // position the button just above the end of the selection
    const scrollX = window.scrollX || window.pageXOffset
    const scrollY = window.scrollY || window.pageYOffset
    top.value = rect.top + scrollY - 40
    left.value = rect.left + scrollX + Math.min(rect.width / 2, 120)
    if (top.value < scrollY + 8) {
      top.value = rect.bottom + scrollY + 8
    }
    visible.value = true
  }, 0)
}

function handleSelectionChange() {
  if (typeof window === 'undefined') return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.toString().trim().length < MIN_LEN) {
    visible.value = false
  }
}

function handleDocumentMouseDown(e: MouseEvent) {
  // hide if clicking outside the button (the click handler on the button uses @mousedown.stop)
  const target = e.target as HTMLElement | null
  if (target && target.closest && target.closest('.selection-reporter-btn')) return
  visible.value = false
}

function buildIssueUrl(): string {
  const isEn = isEnLocale()
  const pageTitle = (typeof document !== 'undefined' ? document.title : '').split('|')[0].trim() || 'docs page'
  const title = `[docs] ${pageTitle}`

  let url = typeof window !== 'undefined' ? window.location.href : ''
  if (cachedHeadingAnchor.value && url.indexOf('#') === -1) {
    url = `${url.split('#')[0]}#${cachedHeadingAnchor.value}`
  }

  const quoted = cachedSelectedText.value
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')

  // GitHub permalink to source file + line if known
  const srcFile = cachedSourceFile.value
  const srcLine = cachedSourceLine.value
  const srcLink = srcFile
    ? `https://github.com/${REPO}/blob/main/${srcFile}${srcLine ? `#L${srcLine}` : ''}`
    : ''

  const sourceBlock = isEn
    ? `Source: [\`${srcFile}${srcLine ? `:${srcLine}` : ''}\`](${srcLink})`
    : `源码位置: [\`${srcFile}${srcLine ? `:${srcLine}` : ''}\`](${srcLink})`

  const body = isEn
    ? `Page: ${url}\n${sourceBlock}\n\nSelected text:\n\n${quoted}\n\n---\n_(automated report from anet.sh — line numbers from build-time markdown-it source map; verify before fixing.)_\n`
    : `页面: ${url}\n${sourceBlock}\n\n选中文字:\n\n${quoted}\n\n---\n_(automated report from anet.sh —— 行号来自 markdown-it build 期 source map，提交前请人工核对一下。)_\n`

  const params = new URLSearchParams({
    title,
    body,
    labels: 'docs',
  })
  return `https://github.com/${REPO}/issues/new?${params.toString()}`
}

function onClickReport(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  const url = buildIssueUrl()
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  visible.value = false
  // clear selection so the button doesn't immediately reappear
  if (typeof window !== 'undefined') {
    const sel = window.getSelection()
    if (sel) sel.removeAllRanges()
  }
}

onMounted(() => {
  if (typeof window === 'undefined') return
  document.addEventListener('mouseup', handleMouseUp)
  document.addEventListener('selectionchange', handleSelectionChange)
  document.addEventListener('mousedown', handleDocumentMouseDown)
})

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return
  document.removeEventListener('mouseup', handleMouseUp)
  document.removeEventListener('selectionchange', handleSelectionChange)
  document.removeEventListener('mousedown', handleDocumentMouseDown)
})
</script>

<template>
  <button
    v-if="visible"
    class="selection-reporter-btn"
    :style="{ top: top + 'px', left: left + 'px' }"
    @mousedown.stop.prevent
    @click="onClickReport"
  >
    {{ label }}
  </button>
</template>

<style scoped>
.selection-reporter-btn {
  position: absolute;
  z-index: 9999;
  padding: 6px 12px;
  font-size: 13px;
  line-height: 1.2;
  font-weight: 500;
  color: #fff;
  background: var(--vp-c-brand-1, #3451b2);
  border: 1px solid var(--vp-c-brand-2, #3a5ccc);
  border-radius: 999px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transform: translateX(-50%);
  transition: background 0.15s ease, transform 0.15s ease;
}
.selection-reporter-btn:hover {
  background: var(--vp-c-brand-2, #3a5ccc);
  transform: translateX(-50%) translateY(-1px);
}
.selection-reporter-btn:active {
  transform: translateX(-50%) translateY(0);
}

@media (max-width: 640px) {
  .selection-reporter-btn {
    font-size: 12px;
    padding: 5px 10px;
  }
}
</style>
