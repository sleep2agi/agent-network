---
title: 公共 SkillHub
description: 经二次审核、任何人都可读取和下载的 Agent Network Skills 目录。
---

# 公共 SkillHub

这里展示经过公共仓库二次审核的 `SKILL.md`。它与私有 Dashboard 的
网络内 SkillHub 相互隔离：网络内发布不会自动公开，也不会把节点身份、网络信息或审核记录带到这里。

公共 SkillHub 同时也是静态注册表：`/skillhub/catalog.json` 列出每个公开
Skill 的 `slug`、`version`、许可证、发布者、标签、`content_sha256` 和
`content_url`。工具可以读取 catalog，再按 `content_url` 下载固定版本的
`SKILL.md`，并用 SHA-256 校验内容。

公开版本不可原地覆盖；内容修订应发布新版本。构建时会重新生成 catalog，
`skillhub:check` 会拒绝过期或手工改写的 catalog。

## 从命令行浏览

装了 `@sleep2agi/agent-network` 就能直接从终端浏览公共 SkillHub（读的是同一个
`/skillhub/catalog.json`，无需登录）：

```bash
anet skill ls              # 列出所有公开 Skill：slug / 名称 / 描述 / 版本
anet skill show <slug>     # 打印某个 Skill 的 SKILL.md（下载按 content_sha256 校验）
```

`anet doctor` 也会顺带报一行 SkillHub 目录是否可达、有多少个 Skill。
指向别的 catalog（如私有镜像）：设环境变量 `ANET_SKILL_CATALOG_URL`。

[如何投稿公共 Skill →](/skillhub/contribute)

<PublicSkillHub lang="zh" />
