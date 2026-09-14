<script setup lang="ts">
// 首页英雄区的「活的网络」:节点 = Agent,边 = 通信,脉冲 = 正在传递的任务。
// 纯 Canvas,固定节点数,鼠标只做轻微视差;prefers-reduced-motion 时静止一帧。
import { onMounted, onBeforeUnmount, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
let cleanup: (() => void) | null = null

onMounted(() => {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const isDark = () => document.documentElement.classList.contains('dark')
  let w = 0, h = 0, dpr = 1
  const N = 46
  type Node = { x: number; y: number; vx: number; vy: number; r: number; hue: number }
  const nodes: Node[] = []
  const rand = (a: number, b: number) => a + Math.random() * (b - a)
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = el.clientWidth; h = el.clientHeight
    el.width = Math.floor(w * dpr); el.height = Math.floor(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  for (let i = 0; i < N; i++) {
    nodes.push({ x: rand(0, w), y: rand(0, h), vx: rand(-0.12, 0.12), vy: rand(-0.09, 0.09), r: rand(1.4, 3.2), hue: [170, 190, 235][i % 3] })
  }
  type Pulse = { a: number; b: number; t: number; speed: number }
  const pulses: Pulse[] = []
  let mx = 0.5, my = 0.35
  const onMove = (e: MouseEvent) => { mx = e.clientX / window.innerWidth; my = e.clientY / window.innerHeight }
  window.addEventListener('mousemove', onMove, { passive: true })
  window.addEventListener('resize', resize)
  const LINK = 150
  let last = performance.now()
  const frame = (now: number) => {
    const dt = Math.min(40, now - last); last = now
    const dark = isDark()
    ctx.clearRect(0, 0, w, h)
    const px = (mx - 0.5) * 18, py = (my - 0.5) * 12
    if (!reduced) for (const n of nodes) {
      n.x += n.vx * dt * 0.06; n.y += n.vy * dt * 0.06
      if (n.x < -20) n.x = w + 20; if (n.x > w + 20) n.x = -20
      if (n.y < -20) n.y = h + 20; if (n.y > h + 20) n.y = -20
    }
    // edges
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const a = nodes[i], b = nodes[j]
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy)
      if (d > LINK) continue
      const alpha = (1 - d / LINK) * (dark ? 0.32 : 0.22)
      ctx.strokeStyle = `hsla(${(a.hue + b.hue) / 2}, 80%, ${dark ? 62 : 38}%, ${alpha})`
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(a.x + px, a.y + py); ctx.lineTo(b.x + px, b.y + py); ctx.stroke()
      if (!reduced && pulses.length < 14 && Math.random() < 0.0009 * dt) pulses.push({ a: i, b: j, t: 0, speed: rand(0.0009, 0.0016) })
    }
    // nodes
    for (const n of nodes) {
      ctx.beginPath(); ctx.arc(n.x + px, n.y + py, n.r, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${n.hue}, 85%, ${dark ? 70 : 42}%, ${dark ? 0.85 : 0.7})`
      ctx.fill()
      ctx.beginPath(); ctx.arc(n.x + px, n.y + py, n.r * 3.2, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${n.hue}, 85%, ${dark ? 70 : 45}%, ${dark ? 0.08 : 0.06})`
      ctx.fill()
    }
    // pulses travelling along edges
    for (let k = pulses.length - 1; k >= 0; k--) {
      const p = pulses[k]; p.t += p.speed * dt
      if (p.t >= 1) { pulses.splice(k, 1); continue }
      const a = nodes[p.a], b = nodes[p.b]
      const x = a.x + (b.x - a.x) * p.t + px, y = a.y + (b.y - a.y) * p.t + py
      const g = ctx.createRadialGradient(x, y, 0, x, y, 9)
      g.addColorStop(0, dark ? 'rgba(34,211,238,0.95)' : 'rgba(0,158,126,0.9)')
      g.addColorStop(1, 'rgba(34,211,238,0)')
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill()
    }
    if (!reduced) raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  cleanup = () => { cancelAnimationFrame(raf); window.removeEventListener('mousemove', onMove); window.removeEventListener('resize', resize) }
})
onBeforeUnmount(() => cleanup?.())
</script>

<template>
  <canvas ref="canvas" class="hero-network" aria-hidden="true"></canvas>
</template>
