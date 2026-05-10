<script setup lang="ts">
import { ref, onMounted } from 'vue'

const videoEl = ref<HTMLVideoElement | null>(null)
const showOverlay = ref(true)

onMounted(() => {
  const v = videoEl.value
  if (!v) return
  v.addEventListener('playing', () => {
    showOverlay.value = false
  })
})

function unmuteAndPlay() {
  const v = videoEl.value
  if (!v) return
  v.muted = false
  v.currentTime = 0
  void v.play()
}
</script>

<template>
  <div class="hero-video-card">
    <div class="hero-video-glow" aria-hidden="true"></div>
    <div class="hero-video-frame">
      <video
        ref="videoEl"
        autoplay
        muted
        loop
        playsinline
        preload="metadata"
        poster="/screenshots/dashboard-overview.jpg"
      >
        <source src="https://c.vansin.top/intern/videos/anet_promo_landscape.mp4" type="video/mp4" />
      </video>
      <button
        v-if="showOverlay"
        class="hero-video-play"
        aria-label="Play promo video with sound"
        @click="unmuteAndPlay"
      >
        <span class="hero-video-play-ring"></span>
        <span class="hero-video-play-icon">▶</span>
      </button>
    </div>
    <div class="hero-video-caption">
      <span class="dot"></span>
      <span>Live demo · 65s</span>
    </div>
  </div>
</template>
