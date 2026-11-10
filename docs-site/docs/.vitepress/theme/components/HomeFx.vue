<script setup lang="ts">
// Home-page motion: reveal sections as they scroll in, and tilt the product
// screenshots toward the pointer. Honors prefers-reduced-motion; no-ops off the home page.
import { onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
const route = useRoute()
let io: IntersectionObserver | null = null
const cleanups: Array<() => void> = []
function teardown() { io?.disconnect(); io = null; cleanups.splice(0).forEach(fn => fn()) }
function setup() {
  teardown()
  if (typeof window === 'undefined') return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const targets = document.querySelectorAll<HTMLElement>('.feature-shot, .home-runtimes, .home-video, .desktop-download, .product-path-card, .final-cta, .VPFeature')
  if (!targets.length || reduce || !('IntersectionObserver' in window)) return
  io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('fx-in'); io?.unobserve(e.target) }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
  targets.forEach(el => { el.classList.add('fx'); io!.observe(el) })
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
  document.querySelectorAll<HTMLElement>('.feature-shot-frame, .home-video-frame').forEach(frame => {
    const move = (ev: PointerEvent) => {
      const r = frame.getBoundingClientRect()
      const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5
      frame.style.setProperty('--tilt-x', `${(-y * 5).toFixed(2)}deg`)
      frame.style.setProperty('--tilt-y', `${(x * 7).toFixed(2)}deg`)
      frame.style.setProperty('--glow-x', `${((x + 0.5) * 100).toFixed(1)}%`)
      frame.style.setProperty('--glow-y', `${((y + 0.5) * 100).toFixed(1)}%`)
    }
    const leave = () => { frame.style.setProperty('--tilt-x', '0deg'); frame.style.setProperty('--tilt-y', '0deg') }
    frame.addEventListener('pointermove', move); frame.addEventListener('pointerleave', leave)
    cleanups.push(() => { frame.removeEventListener('pointermove', move); frame.removeEventListener('pointerleave', leave) })
  })
}
onMounted(() => { setup(); watch(() => route.path, () => nextTick(setup)) })
onBeforeUnmount(teardown)
</script>
<template><span hidden /></template>
