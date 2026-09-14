<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import HeroBackdrop from './components/HeroBackdrop.vue'
import HeroLive from './components/HeroLive.vue'
import { useData } from 'vitepress'
import SelectionReporter from './SelectionReporter.vue'

const { Layout } = DefaultTheme
const { lang } = useData()
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <HeroBackdrop />
    </template>
    <template #home-hero-image>
      <HeroLive :lang="lang.startsWith('en') ? 'en' : 'zh'" />
    </template>
    <template #layout-bottom>
      <SelectionReporter />
    </template>
  </Layout>
</template>
