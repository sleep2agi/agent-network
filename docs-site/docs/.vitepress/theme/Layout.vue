<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import HeroVideo from './components/HeroVideo.vue'
import HeroBackdrop from './components/HeroBackdrop.vue'
import HeroBadges from './components/HeroBadges.vue'
import HeroNotice from './components/HeroNotice.vue'
import InstallCommand from './components/InstallCommand.vue'
import FeatureGrid from './components/FeatureGrid.vue'
import SelectionReporter from './SelectionReporter.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #home-hero-before>
      <HeroBackdrop />
    </template>
    <template #home-hero-info-before>
      <HeroNotice />
    </template>
    <template #home-hero-info-after>
      <InstallCommand />
    </template>
    <template #home-hero-actions-after>
      <HeroBadges />
    </template>
    <template #home-hero-image>
      <HeroVideo />
    </template>
    <template #home-features-before>
      <FeatureGrid />
    </template>
    <template #layout-bottom>
      <SelectionReporter />
    </template>
  </Layout>
</template>
