<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

type Asset = {
  platform: string
  kind: string
  role: 'install' | 'audit'
  name: string
  bytes: number | null
  url: string
  mirrorUrl: string | null
}

type Platform = { id: string; assets: Asset[] }

type Catalog = {
  version: string
  tag: string
  source: string
  releaseUrl: string
  publishedAt: string | null
  platforms: Platform[]
}

const props = withDefaults(defineProps<{ lang?: 'zh' | 'en' }>(), { lang: 'zh' })
const loading = ref(true)
const error = ref(false)
const catalog = ref<Catalog | null>(null)

const copy = computed(() => props.lang === 'en' ? {
  loading: 'Looking up the latest published release…',
  error: 'The release list is temporarily unavailable. Download from GitHub Releases.',
  fallback: 'GitHub is temporarily unreachable. These links come from the update manifest and may not be the newest release.',
  notes: 'Release notes',
  all: 'All releases',
  missing: 'This release has no package for this platform.',
  mirror: 'Mirror 1 (China · ModelScope)',
  github: 'Mirror 2 (GitHub)',
  recommended: 'Recommended',
  audit: 'Audit package only. This file cannot be sideloaded.',
  kinds: {
    dmg: 'Disk image (.dmg)',
    nsis: 'Installer (.exe)',
    msi: 'Installer (.msi)',
    deb: 'Debian package (.deb)',
    appimage: 'AppImage',
    apk: 'Package (.apk)',
    ipa: 'Audit package (.ipa)',
  },
  platforms: [
    { id: 'macos', title: 'macOS', note: 'Apple silicon. Open the disk image and drag Agent Network into Applications.' },
    { id: 'windows', title: 'Windows', note: '64-bit Windows 10/11. The .exe is the usual installer; the .msi is for managed installs.' },
    { id: 'linux', title: 'Linux', note: 'Install the .deb with your package manager. For an AppImage, allow it to run as a program, then open it.' },
    { id: 'android', title: 'Android', note: 'Test-signed package for Android 7.0 or newer. If the system blocks it, allow installs from this source.' },
    { id: 'ios', title: 'iOS', note: 'Distributed through TestFlight. There is no public testing link yet. An audit .ipa cannot be sideloaded.' },
  ],
} : {
  loading: '正在读取最新已发布版本…',
  error: '暂时读不到发布列表。请到 GitHub Releases 下载。',
  fallback: 'GitHub 暂时不可用。下面的链接来自更新清单，可能不是最新发布。',
  notes: '版本说明',
  all: '全部历史版本',
  missing: '这一版没有这个平台的安装包。',
  mirror: '线路一（国内 · ModelScope）',
  github: '线路二（GitHub）',
  recommended: '推荐',
  audit: '仅供审计比对，这个文件不能侧载安装。',
  kinds: {
    dmg: '磁盘映像（.dmg）',
    nsis: '安装包（.exe）',
    msi: '安装包（.msi）',
    deb: 'Debian 包（.deb）',
    appimage: 'AppImage',
    apk: '安装包（.apk）',
    ipa: '审计包（.ipa）',
  },
  platforms: [
    { id: 'macos', title: 'macOS', note: 'Apple 芯片。打开 dmg，把 Agent Network 拖进「应用程序」。' },
    { id: 'windows', title: 'Windows', note: '64 位 Windows 10/11。.exe 是常规安装包；.msi 适合集中部署。' },
    { id: 'linux', title: 'Linux', note: '.deb 用系统的软件包安装器安装。AppImage 需要允许作为程序执行后再打开。' },
    { id: 'android', title: 'Android', note: '测试签名安装包，需 Android 7.0 及以上。系统若拦截，允许来自此来源的安装。' },
    { id: 'ios', title: 'iOS', note: '只通过 TestFlight 分发，公开测试链接还没开。审计用 .ipa 不能侧载安装。' },
  ],
})

const platformAssets = (id: string) => catalog.value?.platforms.find((platform) => platform.id === id)?.assets ?? []
const installAssets = (id: string) => platformAssets(id).filter((asset) => asset.role === 'install')
const auditAssets = (id: string) => platformAssets(id).filter((asset) => asset.role === 'audit')

const sizeLabel = (bytes: number | null) => {
  if (typeof bytes !== 'number') return ''
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const kindLabel = (kind: string) => {
  const kinds = copy.value.kinds as Record<string, string>
  return kinds[kind] ?? kind
}

onMounted(async () => {
  try {
    const response = await fetch(withBase('/api/desktop-downloads'), { cache: 'no-store' })
    if (!response.ok) throw new Error(`downloads HTTP ${response.status}`)
    const payload = await response.json()
    if (!payload?.version || !Array.isArray(payload.platforms)) throw new Error('invalid catalog')
    catalog.value = payload
  } catch (cause) {
    console.error(cause)
    error.value = true
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="download-page" :data-download-catalog="lang">
    <p v-if="loading" class="download-note">{{ copy.loading }}</p>
    <p v-else-if="error" class="download-note">
      {{ copy.error }}
      <a href="https://github.com/sleep2agi/agent-network-app/releases">GitHub Releases</a>
    </p>
    <template v-else-if="catalog">
      <p class="download-note">
        <strong>{{ catalog.tag }}</strong>
        <template v-if="catalog.source === 'fallback'"> · {{ copy.fallback }}</template>
      </p>
      <section
        v-for="platform in copy.platforms"
        :id="platform.id"
        :key="platform.id"
        class="desktop-download"
        :aria-labelledby="`${platform.id}-title`"
      >
        <div class="desktop-download-copy">
          <span class="download-platform"><strong>{{ platform.title }}</strong> · v{{ catalog.version }}</span>
          <h2 :id="`${platform.id}-title`">{{ platform.title }}</h2>
          <p>{{ platform.note }}</p>
        </div>
        <div v-if="installAssets(platform.id).length" class="download-grid">
          <div
            v-for="asset in installAssets(platform.id)"
            :key="asset.name"
            class="download-card download-card-routes download-card-primary"
          >
            <span class="download-platform"><strong>{{ kindLabel(asset.kind) }}</strong></span>
            <small>{{ asset.name }}<template v-if="sizeLabel(asset.bytes)"> · {{ sizeLabel(asset.bytes) }}</template></small>
            <div class="download-routes">
              <a
                v-if="asset.mirrorUrl"
                class="download-route download-route-primary"
                :href="asset.mirrorUrl"
              >{{ copy.mirror }}<span class="download-route-tag">{{ copy.recommended }}</span></a>
              <a class="download-route" :href="asset.url" rel="noopener">{{ copy.github }}</a>
            </div>
          </div>
        </div>
        <p v-else-if="platform.id !== 'ios'" class="download-note">{{ copy.missing }}</p>
        <div v-if="platform.id === 'ios' && auditAssets(platform.id).length === 0" class="download-grid">
          <div class="download-card download-card-pending" aria-disabled="true">
            <span class="download-platform">TestFlight</span>
            <strong>{{ lang === 'en' ? 'Public link not open yet' : '公开链接还没开' }}</strong>
          </div>
        </div>
        <div v-for="asset in auditAssets(platform.id)" :key="asset.name" class="download-note">
          {{ copy.audit }}
          <a :href="asset.url" rel="noopener">{{ asset.name }}</a>
        </div>
      </section>
      <p class="release-links">
        <a :href="catalog.releaseUrl" rel="noopener">{{ copy.notes }}</a>
        ·
        <a href="https://github.com/sleep2agi/agent-network-app/releases" rel="noopener">{{ copy.all }}</a>
      </p>
    </template>
  </div>
</template>
