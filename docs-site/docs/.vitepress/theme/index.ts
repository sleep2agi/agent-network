import DefaultTheme from 'vitepress/theme'
import Layout from './Layout.vue'
import PublicSkillHub from './PublicSkillHub.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('PublicSkillHub', PublicSkillHub)
  },
}
