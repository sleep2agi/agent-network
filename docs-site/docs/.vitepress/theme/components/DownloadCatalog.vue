<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

type Asset = {
  platform: string
  kind: string
  role: 'install' | 'audit' | 'devtest'
  name: string
  bytes: number | null
  url: string | null
  mirrorUrl: string | null
  architecture?: string | null
  version?: string
  notesUrl?: string
  checksumUrl?: string
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
const currentPlatform = ref('')
const recommendedAsset = computed(() => installAssets(currentPlatform.value)[0])
const platformTitle = (id: string) => copy.value.platforms.find((platform) => platform.id === id)?.title ?? id
const architectureLabel = (asset: Asset) => asset.architecture === 'arm64'
  ? (asset.platform === 'macos' ? 'Apple Silicon · ARM64' : 'ARM64')
  : asset.architecture === 'x64' ? (asset.platform === 'macos' ? 'Intel · x64' : 'x64')
  : asset.architecture === 'universal' ? (props.lang === 'en' ? 'Universal' : '通用包')
  : (props.lang === 'en' ? 'See filename for architecture' : '架构见文件名')

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
  downloadFor: 'Download for',
  verifyArch: 'Check the architecture below before installing. No automatic download.',
  checksum: 'SHA256 checksum',
  cli: 'CLI / Daemon installation',
  audit: 'Audit package only. This file cannot be sideloaded.',
  devtest: 'Developer test build: installs only on devices whose UDID is registered in its signing profile (Developer mode on, then hdc install). Other devices: wait for the public release.',
  kinds: {
    dmg: 'Disk image (.dmg)',
    nsis: 'Installer (.exe)',
    msi: 'Installer (.msi)',
    deb: 'Debian package (.deb)',
    appimage: 'AppImage',
    apk: 'Package (.apk)',
    hap: 'Package (.hap)',
    ipa: 'Audit package (.ipa)',
  },
  platforms: [
    { id: 'macos', title: 'macOS', note: 'Apple silicon. Open the disk image and drag Agent Network into Applications.' },
    { id: 'windows', title: 'Windows', note: '64-bit Windows 10/11. The .exe is the usual installer; the .msi is for managed installs. If SmartScreen shows “Unknown publisher” for the installer you downloaded from this page, choose “More info”, then “Run anyway” to continue.' },
    { id: 'android', title: 'Android', note: 'Test-signed package for Android 7.0 or newer. If the system blocks it, allow installs from this source.' },
    { id: 'harmony', title: 'HarmonyOS', note: 'For HarmonyOS NEXT (HarmonyOS 5 / 6), which cannot install Android packages. HarmonyOS 4 and earlier can use the Android package above.' },
    { id: 'linux', title: 'Linux', note: 'Linux builds are not a priority in this release. Only published packages are listed.' },
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
  downloadFor: '下载',
  verifyArch: '安装前请核对下面的架构；不会自动开始下载。',
  checksum: 'SHA256 校验文件',
  cli: 'CLI / Daemon 安装',
  audit: '仅供审计比对，这个文件不能侧载安装。',
  devtest: '开发者内测包：只有签名里登记过 UDID 的设备能装（打开开发者模式后用 hdc install）。其他设备请等公开发行版。',
  kinds: {
    dmg: '磁盘映像（.dmg）',
    nsis: '安装包（.exe）',
    msi: '安装包（.msi）',
    deb: 'Debian 包（.deb）',
    appimage: 'AppImage',
    apk: '安装包（.apk）',
    hap: '安装包（.hap）',
    ipa: '审计包（.ipa）',
  },
  platforms: [
    { id: 'macos', title: 'macOS', note: 'Apple 芯片。打开 dmg，把 Agent Network 拖进「应用程序」。' },
    { id: 'windows', title: 'Windows', note: '64 位 Windows 10/11。.exe 是常规安装包；.msi 适合集中部署。如果 SmartScreen 对从本页下载的安装包提示「未知发布者」，请选择「更多信息」，再点「仍要运行」继续安装。' },
    { id: 'android', title: 'Android', note: '测试签名安装包，需 Android 7.0 及以上。系统若拦截，允许来自此来源的安装。' },
    { id: 'harmony', title: '鸿蒙 HarmonyOS', note: '给鸿蒙 NEXT（HarmonyOS 5 / 6）用，这类系统装不了安卓包。HarmonyOS 4 及更早的版本直接用上面的安卓包。' },
    { id: 'linux', title: 'Linux', note: 'Linux 后续支持；这里只展示实际已发布的安装包。' },
    { id: 'ios', title: 'iOS', note: '只通过 TestFlight 分发，公开测试链接还没开。审计用 .ipa 不能侧载安装。' },
  ],
})

const platformAssets = (id: string) => catalog.value?.platforms.find((platform) => platform.id === id)?.assets ?? []
const installAssets = (id: string) => platformAssets(id).filter((asset) => asset.role === 'install')
const auditAssets = (id: string) => platformAssets(id).filter((asset) => asset.role === 'audit')
const devAssets = (id: string) => platformAssets(id).filter((asset) => asset.role === 'devtest')

const sizeLabel = (bytes: number | null) => {
  if (typeof bytes !== 'number') return ''
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const kindLabel = (kind: string) => {
  const kinds = copy.value.kinds as Record<string, string>
  return kinds[kind] ?? kind
}

onMounted(async () => {
  const ua = navigator.userAgent
  // 鸿蒙 NEXT 的浏览器 UA 带 OpenHarmony / HarmonyOS 且没有 Android;老鸿蒙(带 Android)仍按安卓推荐。
  currentPlatform.value = /OpenHarmony|HarmonyOS/i.test(ua) && !/Android/i.test(ua) ? 'harmony'
    : /Android/i.test(ua) ? 'android' : /Windows/i.test(ua) ? 'windows'
    : /Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua) ? 'macos' : /Linux/i.test(ua) ? 'linux' : ''
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
      <div v-if="recommendedAsset" class="download-recommendation">
        <span>{{ copy.recommended }} · {{ platformTitle(currentPlatform) }} · {{ architectureLabel(recommendedAsset) }} · v{{ recommendedAsset.version || catalog.version }}</span>
        <a class="download-route download-route-primary" :href="recommendedAsset.mirrorUrl || recommendedAsset.url || undefined">
          {{ copy.downloadFor }} {{ platformTitle(currentPlatform) }} ↓
        </a>
        <small>{{ copy.verifyArch }}</small>
      </div>
      <p class="download-release">
        <strong class="download-release-tag">{{ catalog.tag }}</strong>
        <time v-if="catalog.publishedAt" :datetime="catalog.publishedAt">{{ catalog.publishedAt.slice(0, 10) }}</time>
        <span v-if="catalog.source === 'fallback'" class="download-release-fallback">{{ copy.fallback }}</span>
      </p>
      <section
        v-for="platform in copy.platforms"
        :id="platform.id"
        :key="platform.id"
        class="desktop-download"
        :aria-labelledby="`${platform.id}-title`"
      >
        <div class="desktop-download-copy">
          <div class="download-platform-head">
            <h2 :id="`${platform.id}-title`">{{ platform.title }}</h2>
            <span class="download-platform-version" v-if="installAssets(platform.id).length">v{{ installAssets(platform.id)[0].version || catalog.version }}</span>
          </div>
          <p>{{ platform.note }}</p>
        </div>
        <div v-if="installAssets(platform.id).length" class="download-grid">
          <div
            v-for="asset in installAssets(platform.id)"
            :key="asset.name"
            class="download-card download-card-routes download-card-primary"
          >
            <span class="download-platform"><strong>{{ architectureLabel(asset) }} · {{ kindLabel(asset.kind) }}</strong></span>
            <small>{{ asset.name }}<template v-if="sizeLabel(asset.bytes)"> · {{ sizeLabel(asset.bytes) }}</template></small>
            <div class="download-routes">
              <a
                v-if="asset.mirrorUrl"
                class="download-route download-route-primary"
                :href="asset.mirrorUrl"
              >{{ copy.mirror }}<span class="download-route-tag">{{ copy.recommended }}</span></a>
              <a v-if="asset.url" class="download-route" :href="asset.url" rel="noopener">{{ copy.github }}</a>
              <a v-if="asset.notesUrl" class="download-route" :href="asset.notesUrl">{{ copy.notes }}</a>
              <a v-if="asset.checksumUrl" class="download-route" :href="asset.checksumUrl">{{ copy.checksum }}</a>
            </div>
          </div>
        </div>
        <div v-else-if="platform.id === 'harmony'" class="download-grid">
          <div class="download-card download-card-pending" aria-disabled="true">
            <span class="download-platform">{{ lang === 'en' ? 'HarmonyOS package (.hap)' : '鸿蒙安装包（.hap）' }}</span>
            <strong>{{ lang === 'en' ? 'Coming soon' : '即将开放' }}</strong>
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
        <div v-for="asset in devAssets(platform.id)" :key="asset.name" class="download-note" :data-devtest="asset.name">
          {{ copy.devtest }}
          <a :href="asset.mirrorUrl || asset.url || undefined" rel="noopener">{{ asset.name }}</a>
        </div>
      </section>
      <p class="release-links">
        <a :href="catalog.releaseUrl" rel="noopener">{{ copy.notes }}</a>
        ·
        <a href="https://github.com/sleep2agi/agent-network-app/releases" rel="noopener">{{ copy.all }}</a>
      </p>
      <p class="download-cli"><a :href="withBase(lang === 'en' ? '/en/guide/install' : '/guide/install')">{{ copy.cli }} →</a></p>
    </template>
  </div>
</template>
