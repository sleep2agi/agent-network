import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'Agent Network',
  description: '本地优先的多 Agent 协作平台 — Apache 2.0 开源，自部署，纯本机',
  cleanUrls: true,
  markdown: {
    // Inject data-source-line attributes on outermost block-level tokens so
    // SelectionReporter can construct a GitHub permalink to the exact line.
    // Restricted to safe token types — tables / nested tokens already carry
    // VitePress-specific attrs and adding more causes Vue SFC duplicate-attr
    // errors during build.
    config: (md) => {
      const SAFE_OPENS = new Set([
        'paragraph_open',
        'heading_open',
        'blockquote_open',
        'hr',
        // skip fence/code_block — VitePress treats their first attr as the
        // language name, which breaks if we prepend data-source-line.
      ])
      md.core.ruler.push('source_line_attrs', (state: any) => {
        state.tokens.forEach((tok: any) => {
          if (
            tok.map &&
            tok.level === 0 &&
            SAFE_OPENS.has(tok.type)
          ) {
            tok.attrSet('data-source-line', String(tok.map[0] + 1))
          }
        })
      })
    },
  },
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
            text: 'v0.9.2 ▾',
            items: [
              { text: 'v0.10.0 preview（in-progress）', link: '/preview/v0.10.0' },
              { text: 'preview channel（pre-release）', link: '/guide/preview/getting-started' },
              { text: 'v0.9.2（latest）', link: '/' },
              { text: 'v0.9.0 → v0.9.2 changelog', link: '/changelog' },
              { text: 'v0.8.0（归档）', link: '/v0.8.0/' },
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
              { text: 'Preview 快速开始', link: '/guide/preview/getting-started' },
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
              { text: '批量 Agent', link: '/guide/batch' },
              { text: 'Agent Node', link: '/guide/agent-node' },
              { text: '节点 Runtime', link: '/guide/runtimes' },
              { text: 'SDK Deep-dive', link: '/guide/sdk-deep-dive' },
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
              { text: 'Vendor 适配层', link: '/concepts/vendor-adapters' },
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
              { text: 'PR 审查室', link: '/cases/pr-review-room' },
              { text: '你好世界', link: '/cases/hello-world' },
              { text: '翻译流水线', link: '/cases/translation-pipeline' },
              { text: '军团编队', link: '/cases/telegram-squad' },
              { text: 'Telegram 接入已存在节点 (claude-code-cli)', link: '/cases/telegram-bind-claude-code-cli' },
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
      description: 'Local-first Multi-Agent Collaboration — Apache 2.0 open source, self-hosted',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/getting-started' },
          { text: 'API', link: '/en/api/mcp-tools' },
          { text: 'Examples / Demo', link: '/en/cases/' },
          { text: 'Ecosystem', link: '/en/ecosystem' },
          { text: 'Community', link: '/en/community' },
          {
            text: 'v0.9.2 ▾',
            items: [
              { text: 'v0.10.0 preview (in-progress)', link: '/en/preview/v0.10.0' },
              { text: 'preview channel (pre-release)', link: '/guide/preview/getting-started' },
              { text: 'v0.9.2 (latest)', link: '/en/' },
              { text: 'v0.9.0 → v0.9.2 changelog', link: '/en/changelog' },
              { text: 'v0.8.0 (archive)', link: '/v0.8.0/' },
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
              { text: 'Batch Agents', link: '/en/guide/batch' },
              { text: 'Agent Node', link: '/en/guide/agent-node' },
              { text: 'Node Runtime', link: '/en/guide/runtimes' },
              { text: 'SDK Deep-dive', link: '/en/guide/sdk-deep-dive' },
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
              { text: 'Vendor Adapters', link: '/en/concepts/vendor-adapters' },
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
              { text: 'PR Review Room', link: '/en/cases/pr-review-room' },
              { text: 'Hello World', link: '/en/cases/hello-world' },
              { text: 'Translation Pipeline', link: '/en/cases/translation-pipeline' },
              { text: 'Telegram Squad', link: '/en/cases/telegram-squad' },
              { text: 'Bind Telegram to existing node (claude-code-cli)', link: '/en/cases/telegram-bind-claude-code-cli' },
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
    editLink: {
      pattern: 'https://github.com/sleep2agi/agent-network/edit/main/docs-site/docs/:path',
      text: '在 GitHub 上编辑此页 / Edit this page on GitHub',
    },
    lastUpdated: { text: '更新于 / Updated' },
  },
  mermaid: {},
  lastUpdated: true,
}))
