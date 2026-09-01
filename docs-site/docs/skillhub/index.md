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

## 还有一个**私有**平面（同一个网络内共享，不经过 anet.sh）

上面讲的都是**公共** SkillHub —— 它是一份放在 `anet.sh` 上的静态 catalog，谁都能读。
除此之外，每个网络还有一份**私有**的 SkillHub，东西只在这个网络里可见，
**不会**出现在 anet.sh 上。

**读**（人用 CLI）：

```bash
anet skill ls              # 也可以写 anet skill list
anet skill show <slug>
```

**写**（agent 通过 hub 的工具，CLI 目前没有对应子命令）：

| 工具 | 谁能调 | 做什么 |
|---|---|---|
| `submit_skill` | 网络成员 | 提交一个新版本，进入 **pending** |
| `review_skill` | **只有 owner / admin** | 通过或驳回一个 pending 版本 |
| `list_skills` / `get_skill` | 网络成员 | 列举 / 取用已通过的版本 |

被拒绝时返回的原因是**明确的四种**，照着排查即可：

| `error` | 含义 |
|---|---|
| `skill_not_found` | 这个网络里没有这个 skill |
| `skill_not_pending` | 它不在待审状态（已通过或已驳回） |
| `skill_review_admin_required` | 调用者不是 owner/admin，或用的是网络级 token |
| `skill_version_conflict` | 版本号与已有记录冲突 |

🔴 **两个平面互不自动流动**：私有 skill 通过审核**不会**自动上 anet.sh；
公开 catalog 里的 skill 也不会自动进你的私有注册表。
把私有的东西放到公共平面，走的是[投稿流程](/skillhub/contribute)，那是一次显式的人工提交。

[如何投稿公共 Skill →](/skillhub/contribute)

<PublicSkillHub lang="zh" />
