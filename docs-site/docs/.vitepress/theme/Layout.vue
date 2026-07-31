<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import HeroBackdrop from './components/HeroBackdrop.vue'
import SelectionReporter from './SelectionReporter.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <HeroBackdrop />
    </template>
    <template #layout-bottom>
      <SelectionReporter />
    </template>
  </Layout>
</template>
