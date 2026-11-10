# 凭据台账（5 列最小版）

> 父卡 #2719 · 本文件由 #3306 建立 · 数据由 #3307 填（需 admin）

## 为什么要有这张表

这几天所有混乱的根源，是没有一张「哪把钥匙被谁、在哪条流水线、什么时候用过」的表：

- 两把明文 App Store Connect Key 在盘上放了 4 个月，没人知道谁在用；
- 签名私钥唯一副本在无备份的机器上；
- 换 key 时要改 3 个 secret，而没人清楚除 CI 外还有谁在消费。

⇒ 缺了这张表，每次出事都要从头考古。

## 规则（三条，违反任一条这张表就会变成新的风险）

```text
① 只记元数据：名字 / 指纹或 KeyID / 持有人 / 用途 / 最近一次使用 / 撤销要改哪里
   —— **永不粘贴密钥内容**。指纹是哈希，KeyID 是标识，两者都不是密钥。
② 每行必须写「撤销后要改哪些地方」。没有它，台账只回答「谁持有」，不回答「换掉要动什么」——
   而那正是出事那一刻要查的东西。
③ 待填行显式写「（待填）」并计数：**空表与填好的表在报告上同形**，
   所以本文件必须自带「已填 / 待填」的读数。
```

## 台账

| 资产名 | 指纹 / KeyID | 持有人 | 用途 | 最近一次使用 | 撤销后要改哪些地方 |
|---|---|---|---|---|---|
| Developer ID Application（mac 签名证书） | （待填：`security find-identity` 的 SHA-1） | （待填） | mac 包签名 | （待填） | （待填） |
| App Store Connect API Key（公证） | （待填：KeyID，10 位） | （待填） | 公证 / 提交 | （待填） | （待填） |
| CI secret ①（npm 发布令牌） | `secrets.NPM_TOKEN` | （待填：admin） | `release.yml` 发布 / `promote-latest.yml` 升 latest | （待填：admin） | 两个 workflow 各有一条引用；另有 `NPM_TRUSTED_PUBLISHING=true` 时改走 OIDC 不读本 secret ⇒ 换 key 时先确认 OIDC 通道是否已启用 |
| CI secret ②（Vercel 部署令牌） | `secrets.VERCEL_TOKEN` + `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID` | （待填：admin） | `deploy-anet-sh.yml` 部署官网 | （待填：admin） | 换 token 时**三项要一起换**（org/project id 与 token 必须同属一个账号；只换 token 会 403 且报错不指向权限） |
| CI secret ③（Codex 登录态 + GitHub token） | `secrets.CODEX_AUTH_JSON` · `secrets.GITHUB_TOKEN`（内置） | （待填：admin） | `windows-real-codex-gate.yml` 用 Codex 登录态；`release.yml` 用内置 GITHUB_TOKEN | （待填：admin） | `CODEX_AUTH_JSON` 是账号级登录态 ⇒ 撤销 = 重新登录并把新 JSON 写回 secret；`GITHUB_TOKEN` 由 GitHub 每次运行现签，无需撤销，但要查 `permissions:` 是否被放宽 |
| 本地副本位置 | 路径即可：`~/.npmrc`（npm token）· `~/.config/gh/hosts.yml`（GitHub oauth_token）· `~/.anet/nodes/*/config.json`（node token）· `~/.anet/nodes/*/secrets.env`（若存在） | （待填：admin） | 离线/本机使用 | （待填：admin） | 撤销 = 删/替换上述文件；`config.json` 里的 node token 还要在 Hub 侧作废（否则删文件不等于吊销） |

## 读数（本行必须随表一起更新）

```text
已填 0 行 / 待填 6 行

（逐行进度：**名称 / 用途 / 撤销改点已填 4 行**，其中 3 行是 CI secret、1 行是本机副本位置；
「持有人」与「最近一次使用」两列**仍需 admin**，所以上面的计数仍按整行算。）
最后更新：2026-11-01（#3306 建表；数据待 #3307）
```

> ⚠️ 「已填 0」与「这张表不需要」在报告上同形 —— 所以这一行不是装饰，
> 它是本文件唯一能证明「有人真的维护过」的读数。

## 与 #2503 的互相引用

#2503（Mac mini 无备份 + 磁盘 91%）的撤销流程要求：**撤销前后各更新一次本表**。
- 撤销前：把该行的「最近一次使用」写到当天，并确认「撤销后要改哪些地方」齐全；
- 撤销后：把该行的指纹/KeyID 标为 `(已撤销 YYYY-MM-DD)`，并新增替换后的行。

## 边界

- 本文件**不进聊天附件、不进工单正文**；只在本仓库内被引用。
- 不记录：密钥内容、口令、token 值、私钥、助记词。
- 指纹与 KeyID 可以公开：它们是**标识**，不是凭据。
