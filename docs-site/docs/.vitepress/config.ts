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
          { text: '生态', link: '/ecosystem' },
          { text: '社群', link: '/community' },
          {
            text: '更新日志',
            items: [
              { text: 'Changelog（全部版本）', link: '/changelog' },
              { text: 'GitHub releases', link: 'https://github.com/sleep2agi/agent-network/releases' },
            ]
          },
          {
            text: 'latest ▾',
            items: [
              { text: 'latest（稳定版 · npm latest）', link: '/' },
              { text: 'preview（2.3.0-preview.1）', link: '/preview/' },
            ]
          },
        ],
        sidebar: [
          {
            text: '快速开始',
            items: [
              { text: '5 分钟懂 anet', link: '/guide/introduction' },
              { text: '30 秒上手', link: '/guide/getting-started' },
              { text: 'Windows 上手', link: '/guide/windows' },
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
              { text: 'Grok 人机共存 TUI (preview)', link: '/guide/grok-copresence' },
              { text: 'Grok Build ACP Runtime ↗', link: 'https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md' },
              { text: 'SDK Deep-dive', link: '/guide/sdk-deep-dive' },
              { text: 'Channel 接入', link: '/guide/channels' },
              { text: '飞书 Channel 接入', link: '/guide/feishu' },
              { text: '多模型配置', link: '/guide/multi-model' },
              { text: '升级指南', link: '/guide/upgrade' },
              { text: '版本号体系', link: '/guide/versioning' },
            ]
          },
          {
            text: '核心概念',
            items: [
              { text: '核心概念（基础）', link: '/guide/basics' },
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
              { text: '干净服务器从零部署', link: '/deploy/clean-server' },
              { text: 'Docker 部署', link: '/deploy/docker' },
              { text: 'npm 部署', link: '/deploy/npm' },
              { text: '生产部署 / 公网部署安全', link: '/deploy/production' },
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
            text: '帮助',
            items: [
              { text: '故障排查', link: '/troubleshooting' },
              { text: '连接 / Channel / MCP 排障', link: '/troubleshooting/connectivity-channels-mcp' },
              { text: '经典案例：飞书静默拒收', link: '/troubleshooting/case-feishu-silent-deny' },
              { text: '远程建节点：CLI 登录态不跨机', link: '/troubleshooting/remote-node-cli-login' },
              { text: 'FAQ', link: '/faq' },
              { text: '更新日志', link: '/changelog' },
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
          { text: 'Ecosystem', link: '/en/ecosystem' },
          { text: 'Community', link: '/en/community' },
          {
            text: 'Changelog',
            items: [
              { text: 'Changelog (all versions)', link: '/en/changelog' },
              { text: 'GitHub releases', link: 'https://github.com/sleep2agi/agent-network/releases' },
            ]
          },
          {
            text: 'latest ▾',
            items: [
              { text: 'latest (stable · npm latest)', link: '/en/' },
              { text: 'preview (2.3.0-preview.1)', link: '/en/preview/' },
            ]
          },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: '5-Minute Intro to anet', link: '/en/guide/introduction' },
              { text: '30-Second Quickstart', link: '/en/guide/getting-started' },
              { text: 'Windows Setup', link: '/en/guide/windows' },
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
              { text: 'Grok Co-presence TUI (preview)', link: '/en/guide/grok-copresence' },
              { text: 'Grok Build ACP Runtime ↗', link: 'https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md' },
              { text: 'SDK Deep-dive', link: '/en/guide/sdk-deep-dive' },
              { text: 'Channel Integration', link: '/en/guide/channels' },
              { text: 'Feishu Channel Integration', link: '/en/guide/feishu' },
              { text: 'Multi-Model Config', link: '/en/guide/multi-model' },
              { text: 'Upgrade Guide', link: '/en/guide/upgrade' },
              { text: 'Versioning', link: '/en/guide/versioning' },
            ]
          },
          {
            text: 'Core Concepts',
            items: [
              { text: 'Core Concepts (Basics)', link: '/en/guide/basics' },
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
              { text: 'Fresh Server From Scratch', link: '/en/deploy/clean-server' },
              { text: 'Docker', link: '/en/deploy/docker' },
              { text: 'npm', link: '/en/deploy/npm' },
              { text: 'Production / Public Internet', link: '/en/deploy/production' },
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
            text: 'Help',
            items: [
              { text: 'Troubleshooting', link: '/en/troubleshooting' },
              { text: 'Connectivity / Channels / MCP', link: '/en/troubleshooting/connectivity-channels-mcp' },
              { text: 'Case Study: Feishu Silent Deny', link: '/en/troubleshooting/case-feishu-silent-deny' },
              { text: 'Remote Nodes: CLI Login Not Portable', link: '/en/troubleshooting/remote-node-cli-login' },
              { text: 'FAQ', link: '/en/faq' },
              { text: 'Changelog', link: '/en/changelog' },
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
