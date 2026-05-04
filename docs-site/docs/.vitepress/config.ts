import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'Agent Network',
  description: '企业级 AI Agent 军团管控平台',
  cleanUrls: true,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/guide/getting-started' },
          { text: 'API', link: '/api/mcp-tools' },
          { text: 'Demo', link: '/deploy/demo' },
        ],
        sidebar: [
          {
            text: '快速开始',
            items: [
              { text: '基本概念', link: '/guide/basics' },
              { text: '简介', link: '/guide/introduction' },
              { text: '上手指南', link: '/guide/getting-started' },
              { text: '一键安装 (多 Agent + tmux)', link: '/guide/one-shot-install' },
              { text: '架构概览', link: '/guide/architecture' },
            ]
          },
          {
            text: '使用指南',
            items: [
              { text: '账号体系', link: '/guide/account-system' },
              { text: 'Dashboard', link: '/guide/dashboard' },
              { text: 'CLI 命令', link: '/guide/cli' },
              { text: 'Agent Node', link: '/guide/agent-node' },
              { text: 'Channel 接入', link: '/guide/channels' },
              { text: '多模型配置', link: '/guide/multi-model' },
              { text: '升级指南', link: '/guide/upgrade' },
            ]
          },
          {
            text: '核心概念',
            items: [
              { text: 'Token 体系', link: '/concepts/tokens' },
              { text: '网络隔离', link: '/concepts/networks' },
              { text: '任务生命周期', link: '/concepts/task-lifecycle' },
              { text: '安全设计', link: '/concepts/security' },
            ]
          },
          {
            text: '部署',
            items: [
              { text: 'Docker 部署', link: '/deploy/docker' },
              { text: 'npm 部署', link: '/deploy/npm' },
              { text: 'Demo 编排', link: '/deploy/demo' },
              { text: '🎙️ 辩论赛 Demo', link: '/deploy/demo-debate' },
            ]
          },
          {
            text: '案例',
            items: [
              { text: '案例总览', link: '/cases/' },
              { text: '你好世界', link: '/cases/hello-world' },
              { text: '翻译流水线', link: '/cases/translation-pipeline' },
              { text: '代码审查', link: '/cases/code-review' },
              { text: '成语接龙', link: '/cases/idiom-chain' },
              { text: '军团编队', link: '/cases/telegram-squad' },
              { text: '混合模型协作', link: '/cases/mixed-model' },
            ]
          },
          {
            text: 'API 参考',
            items: [
              { text: 'MCP Tools', link: '/api/mcp-tools' },
              { text: 'REST API', link: '/api/rest' },
            ]
          },
          {
            text: '更多',
            items: [
              { text: 'FAQ', link: '/faq' },
              { text: '更新日志', link: '/changelog' },
              { text: '故障排查', link: '/troubleshooting' },
            ]
          },
        ],
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      description: 'Enterprise-grade Multi-Agent Orchestration Platform',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/getting-started' },
          { text: 'API', link: '/en/api/mcp-tools' },
          { text: 'Demo', link: '/deploy/demo' },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'Key Concepts', link: '/en/guide/basics' },
              { text: 'Introduction', link: '/en/guide/introduction' },
              { text: 'Getting Started', link: '/en/guide/getting-started' },
              { text: 'Architecture', link: '/en/guide/architecture' },
            ]
          },
          {
            text: 'User Guide',
            items: [
              { text: 'Account System', link: '/en/guide/account-system' },
              { text: 'Dashboard', link: '/en/guide/dashboard' },
              { text: 'CLI Commands', link: '/en/guide/cli' },
              { text: 'Agent Node', link: '/en/guide/agent-node' },
              { text: 'Channel Integration', link: '/en/guide/channels' },
              { text: 'Multi-Model Config', link: '/en/guide/multi-model' },
              { text: 'Upgrade Guide', link: '/en/guide/upgrade' },
            ]
          },
          {
            text: 'Core Concepts',
            items: [
              { text: 'Token System', link: '/en/concepts/tokens' },
              { text: 'Network Isolation', link: '/en/concepts/networks' },
              { text: 'Task Lifecycle', link: '/en/concepts/task-lifecycle' },
              { text: 'Security Design', link: '/en/concepts/security' },
            ]
          },
          {
            text: 'Deployment',
            items: [
              { text: 'Docker', link: '/en/deploy/docker' },
              { text: 'npm', link: '/en/deploy/npm' },
              { text: 'Demo Orchestration', link: '/en/deploy/demo' },
            ]
          },
          {
            text: 'Examples',
            items: [
              { text: 'Overview', link: '/en/cases/' },
              { text: 'Hello World', link: '/en/cases/hello-world' },
              { text: 'Translation Pipeline', link: '/en/cases/translation-pipeline' },
              { text: 'Code Review', link: '/en/cases/code-review' },
              { text: 'Idiom Chain Game', link: '/en/cases/idiom-chain' },
              { text: 'Telegram Squad', link: '/en/cases/telegram-squad' },
              { text: 'Mixed Model Collab', link: '/en/cases/mixed-model' },
            ]
          },
          {
            text: 'API Reference',
            items: [
              { text: 'MCP Tools', link: '/en/api/mcp-tools' },
              { text: 'REST API', link: '/en/api/rest' },
            ]
          },
          {
            text: 'More',
            items: [
              { text: 'FAQ', link: '/en/faq' },
              { text: 'Changelog', link: '/en/changelog' },
              { text: 'Troubleshooting', link: '/en/troubleshooting' },
            ]
          },
        ],
      },
    },
  },
  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/sleep2agi/agent-network' }
    ],
    search: { provider: 'local' },
    footer: { message: 'Powered by CommHub V3', copyright: '© 2026 sleep2agi' },
  },
  mermaid: {},
}))
