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
          { text: '案例 / Demo', link: '/cases/' },
          { text: '生态', link: '/ecosystem' },
          { text: '社群', link: '/community' },
          {
            text: 'v0.8.1 ▾',
            items: [
              { text: 'v0.8.1（latest）', link: '/' },
              { text: 'v0.8.0（归档）', link: '/v0.8.0/' },
              { text: '更新日志', link: '/changelog' },
              { text: 'GitHub releases', link: 'https://github.com/sleep2agi/agent-network/releases' },
            ]
          },
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
              { text: '节点 Runtime', link: '/guide/runtimes' },
              { text: 'Channel 接入', link: '/guide/channels' },
              { text: '多模型配置', link: '/guide/multi-model' },
              { text: '升级指南', link: '/guide/upgrade' },
            ]
          },
          {
            text: '核心概念',
            items: [
              { text: 'Token 体系', link: '/concepts/tokens' },
              { text: '角色与权限', link: '/concepts/roles' },
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
              { text: '生产部署 / 公网部署安全', link: '/deploy/production' },
            ]
          },
          {
            text: '案例',
            items: [
              { text: '案例总览', link: '/cases/' },
              { text: '辩论赛 Demo', link: '/cases/debate' },
              { text: '你好世界', link: '/cases/hello-world' },
              { text: '翻译流水线', link: '/cases/translation-pipeline' },
              { text: '军团编队', link: '/cases/telegram-squad' },
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
          { text: 'Examples / Demo', link: '/en/cases/' },
          { text: 'Ecosystem', link: '/en/ecosystem' },
          { text: 'Community', link: '/en/community' },
          {
            text: 'v0.8.1 ▾',
            items: [
              { text: 'v0.8.1 (latest)', link: '/en/' },
              { text: 'v0.8.0 (archive)', link: '/v0.8.0/' },
              { text: 'Changelog', link: '/en/changelog' },
              { text: 'GitHub releases', link: 'https://github.com/sleep2agi/agent-network/releases' },
            ]
          },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'Key Concepts', link: '/en/guide/basics' },
              { text: 'Introduction', link: '/en/guide/introduction' },
              { text: 'Getting Started', link: '/en/guide/getting-started' },
              { text: 'One-Shot Install (Multi-Agent + tmux)', link: '/en/guide/one-shot-install' },
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
              { text: 'Node Runtime', link: '/en/guide/runtimes' },
              { text: 'Channel Integration', link: '/en/guide/channels' },
              { text: 'Multi-Model Config', link: '/en/guide/multi-model' },
              { text: 'Upgrade Guide', link: '/en/guide/upgrade' },
            ]
          },
          {
            text: 'Core Concepts',
            items: [
              { text: 'Token System', link: '/en/concepts/tokens' },
              { text: 'Roles & Permissions', link: '/en/concepts/roles' },
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
              { text: 'Production / Public Internet', link: '/en/deploy/production' },
            ]
          },
          {
            text: 'Examples',
            items: [
              { text: 'Overview', link: '/en/cases/' },
              { text: 'Debate Demo', link: '/en/cases/debate' },
              { text: 'Hello World', link: '/en/cases/hello-world' },
              { text: 'Translation Pipeline', link: '/en/cases/translation-pipeline' },
              { text: 'Telegram Squad', link: '/en/cases/telegram-squad' },
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
    footer: { message: 'Powered by Sleep2AGI', copyright: '© 2026 sleep2agi' },
  },
  mermaid: {},
}))
