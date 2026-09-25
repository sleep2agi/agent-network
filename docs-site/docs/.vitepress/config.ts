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
          { text: '下载桌面版', link: '/#desktop-download-title' },
          { text: '指南', link: '/guide/install' },
          { text: 'SkillHub', link: '/skillhub/' },
          { text: 'API', link: '/api/mcp-tools' },
          { text: '社区与生态', link: '/community' },
          {
            text: '更新日志',
            items: [
              { text: 'Changelog（全部版本）', link: '/changelog' },
              { text: 'npm 版本（anet CLI）', link: 'https://www.npmjs.com/package/@sleep2agi/agent-network?activeTab=versions' },
              { text: '桌面端 releases（GitHub）', link: 'https://github.com/sleep2agi/agent-network-app/releases' },
            ]
          },
        ],
        sidebar: [
          {
            text: '开始',
            items: [
              { text: '什么是 Agent Network', link: '/guide/introduction' },
              { text: '基本概念', link: '/guide/basics' },
              { text: '安装', link: '/guide/install' },
              { text: '10 分钟跑通第一个节点', link: '/guide/getting-started' },
            ]
          },
          {
            text: '客户端',
            items: [
              { text: '桌面与手机客户端', link: '/guide/desktop-app' },
              { text: 'Web Dashboard', link: '/guide/dashboard' },
            ]
          },
          {
            text: '节点与 Runtime',
            items: [
              { text: 'Agent Node', link: '/guide/agent-node' },
              { text: '选择 Runtime', link: '/guide/runtimes' },
              { text: '支持矩阵', link: '/guide/support-matrix' },
              { text: '模型与供应商', link: '/guide/multi-model' },
              { text: 'Codex TUI 人机共存', link: '/guide/codex-copresence' },
              { text: 'Grok 节点', link: '/guide/grok' },
              { text: 'Goal 与 Loop', link: '/guide/goals-and-loops' },
              { text: 'Channel 接入', link: '/guide/channels' },
              { text: '飞书 Channel', link: '/guide/feishu' },
              { text: 'DSH 节点', link: '/guide/dsh' },
            ]
          },
          {
            text: '部署',
            items: [
              { text: '干净服务器从零部署', link: '/deploy/clean-server' },
              { text: '远程机器：anet daemon', link: '/deploy/daemon' },
              { text: '让 Hub 常驻', link: '/deploy/keep-alive' },
              { text: '生产部署 / 公网部署安全', link: '/deploy/production' },
            ]
          },
          {
            text: '账号与安全',
            items: [
              { text: '账号、Token 与角色', link: '/guide/account-system' },
              { text: '网络隔离', link: '/concepts/networks' },
              { text: '安全设计', link: '/concepts/security' },
              { text: '升级与发布通道', link: '/guide/upgrade' },
            ]
          },
          {
            text: '帮助',
            items: [
              { text: '故障排查', link: '/troubleshooting' },
              { text: '更新日志', link: '/changelog' },
            ]
          },
          {
            text: '参考',
            items: [
              { text: 'CLI 命令', link: '/guide/cli' },
              { text: 'MCP Tools', link: '/api/mcp-tools' },
              { text: 'REST API', link: '/api/rest' },
              { text: '架构概览', link: '/guide/architecture' },
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
          { text: 'Download', link: '/en/#desktop-download-title' },
          { text: 'Guide', link: '/en/guide/install' },
          { text: 'SkillHub', link: '/en/skillhub/' },
          { text: 'API', link: '/en/api/mcp-tools' },
          { text: 'Community', link: '/en/community' },
          {
            text: 'Changelog',
            items: [
              { text: 'Changelog (all versions)', link: '/en/changelog' },
              { text: 'npm versions (anet CLI)', link: 'https://www.npmjs.com/package/@sleep2agi/agent-network?activeTab=versions' },
              { text: 'Desktop releases (GitHub)', link: 'https://github.com/sleep2agi/agent-network-app/releases' },
            ]
          },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'What is Agent Network', link: '/en/guide/introduction' },
              { text: 'Basic Concepts', link: '/en/guide/basics' },
              { text: 'Install', link: '/en/guide/install' },
              { text: 'Your First Node in 10 Minutes', link: '/en/guide/getting-started' },
            ]
          },
          {
            text: 'Clients',
            items: [
              { text: 'Desktop & Mobile Clients', link: '/en/guide/desktop-app' },
              { text: 'Web Dashboard', link: '/en/guide/dashboard' },
            ]
          },
          {
            text: 'Nodes & Runtimes',
            items: [
              { text: 'Agent Node', link: '/en/guide/agent-node' },
              { text: 'Choosing a Runtime', link: '/en/guide/runtimes' },
              { text: 'Support Matrix', link: '/en/guide/support-matrix' },
              { text: 'Models & Providers', link: '/en/guide/multi-model' },
              { text: 'Codex TUI Co-presence', link: '/en/guide/codex-copresence' },
              { text: 'Grok Nodes', link: '/en/guide/grok' },
              { text: 'Goals and Loops', link: '/en/guide/goals-and-loops' },
              { text: 'Channels', link: '/en/guide/channels' },
              { text: 'Feishu Channel', link: '/en/guide/feishu' },
              { text: 'DSH node', link: '/en/guide/dsh' },
            ]
          },
          {
            text: 'Deployment',
            items: [
              { text: 'Fresh Server From Scratch', link: '/en/deploy/clean-server' },
              { text: 'Remote Machines: anet daemon', link: '/en/deploy/daemon' },
              { text: 'Keeping the Hub Running', link: '/en/deploy/keep-alive' },
              { text: 'Production / Public Internet', link: '/en/deploy/production' },
            ]
          },
          {
            text: 'Accounts & Security',
            items: [
              { text: 'Accounts, Tokens & Roles', link: '/en/guide/account-system' },
              { text: 'Network Isolation', link: '/en/concepts/networks' },
              { text: 'Security Design', link: '/en/concepts/security' },
              { text: 'Upgrades & Release Channels', link: '/en/guide/upgrade' },
            ]
          },
          {
            text: 'Help',
            items: [
              { text: 'Troubleshooting', link: '/en/troubleshooting' },
              { text: 'Changelog', link: '/en/changelog' },
            ]
          },
          {
            text: 'Reference',
            items: [
              { text: 'CLI Commands', link: '/en/guide/cli' },
              { text: 'MCP Tools', link: '/en/api/mcp-tools' },
              { text: 'REST API', link: '/en/api/rest' },
              { text: 'Architecture', link: '/en/guide/architecture' },
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
