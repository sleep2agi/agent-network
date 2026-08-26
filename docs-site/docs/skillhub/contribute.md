---
title: 投稿公共 SkillHub
description: 从私有 SkillHub 导出并向 anet.sh 公共目录投稿。
---

# 投稿公共 SkillHub

公共投稿需要两次审核：先由你的网络 owner/admin 将 Skill 设为网络内发布，再由公共仓库维护者审核。
私有发布不等于 Internet 公开，也不会自动公开。

## 投稿步骤

1. 在私有 Dashboard 的 SkillHub 中打开一份已发布 Skill。
2. 点击“导出公共投稿包”，选择明确的开源许可证。
3. 再次检查并删除 token、内部域名、个人路径、客户数据和私有身份信息。
4. Fork [`sleep2agi/agent-network`](https://github.com/sleep2agi/agent-network)，导入 Dashboard 下载的投稿包：

   ```bash
   node scripts/import-public-skill-bundle.mjs ~/Downloads/<bundle>.json
   ```

   导入后会生成：

   ```text
   docs-site/docs/public/skillhub/skills/<slug>/<version>/
   ├── metadata.json
   └── SKILL.md
   ```

5. 在 `docs-site/` 目录运行校验并重新生成 catalog：

   ```bash
   npm run skillhub:build
   npm run skillhub:check
   ```

   提交源文件与更新后的 `docs/public/skillhub/catalog.json`，然后发起 Pull Request。

PR 里应写明新增或更新的 `slug@version`、许可证、公开来源，以及本地
`skillhub:check` 的结果。公共维护者会用公开 catalog 中的
`public-skill-review-checklist` 复核可复用性、许可证、隐私和安全边界。

修改已公开内容时必须发布新版本，不得覆盖原版本。

## 不会上传的内容

Dashboard 导出包不包含 `network_id`、节点 ID、用户 ID、token 绑定 alias、私有审核意见或 Hub 审计数据。
导出只生成本地文件，不会自动发送到 anet.sh。
