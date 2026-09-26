<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { computed } from 'vue'
import { useData } from 'vitepress'
import HomeHeroInstall from './components/HomeHeroInstall.vue'
import HomeShowcase from './components/HomeShowcase.vue'
import HomeDetails from './components/HomeDetails.vue'
import SelectionReporter from './SelectionReporter.vue'

const { Layout } = DefaultTheme
const { lang } = useData()
const homeLang = computed(() => (lang.value.startsWith('en') ? 'en' : 'zh'))
</script>

<template>
  <Layout>
    <template #home-hero-actions-after>
      <HomeHeroInstall :lang="homeLang" />
    </template>
    <template #home-hero-after>
      <HomeShowcase :lang="homeLang" />
    </template>
    <template #home-features-after>
      <HomeDetails :lang="homeLang" />
    </template>
    <template #layout-bottom>
      <SelectionReporter />
    </template>
  </Layout>
</template>
