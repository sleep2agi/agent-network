# anet.sh 文档站部署

对应 `AGENTS.md` §19。补的缺口:**这条部署链此前只存在于个人记忆里** ——
仓里没有任何说明,机器没了就没人知道 anet.sh 是怎么上线的。

## 🔴 最重要的一条:它不会自动部署

`docs-site` 这个 Vercel 项目**没有接 git 自动部署**。合并进 `main` **不会**让站点更新。
必须有人跑一次 CLI。

**症状**:站点内容与 `main` 静默分叉,而且没有任何报错。
**实测**(2026-08-12):文档在线上停了 **36 小时**(`age: 129147`),
期间 `main` 上的改动一个字都没上线。更早还发生过冻结近 14 天。

**自检**(任何时候都能跑):
```bash
curl -s -I -L https://anet.sh/ | grep -i '^age:'          # age 很大 = 很久没部署
curl -sL https://anet.sh/<某个刚改过的页面> | grep '<刚写的那句话>'
```

## 🔴 第二条:必须从 main worktree 部署

主 checkout 常年停在某个 feature 分支,`docs-site` 可能落后 `origin/main`
**上百个 commit**。从它部署会**把旧文档推上线**,而且看起来一切正常。

```bash
git fetch origin main
git worktree add --detach /tmp/anet-site origin/main
cd /tmp/anet-site && git rev-parse --short HEAD      # 必须等于 origin/main
```

## 部署步骤

```bash
cd /tmp/anet-site/docs-site

# 项目关联与构建 env 都在 .vercel/ 里,从主 checkout 带过来
cp -r <主checkout>/docs-site/.vercel .vercel

# 复用已装好的依赖,省一次冷装
ln -sfn <主checkout>/docs-site/node_modules node_modules

# 🔴 本地先构建 —— ignoreDeadLinks 未设,有死链即 fail。
#    不要带着死链上线。
npm run build

# 部署(云端会重新跑 npm run build,含 prebuild 的 skillhub 生成)
vercel --prod --yes
# 期望结尾: Aliased: https://www.anet.sh
```

## 验证:验内容,不验状态码

`200` 只说明站点活着,不说明**你的改动上线了**。

```bash
curl -s -I -L https://anet.sh/<页面> | grep -i '^age:'     # 期望 age: 0(刚部署)
curl -sL https://anet.sh/<页面> | grep '<本次新增的那句话>'  # 必须命中
curl -sL https://anet.sh/en/<页面> | grep '<英文那句>'      # 中英两套都要验
```

🔴 **`vercel.json` 设了 `cleanUrls`**,所以线上 URL 没有 `.html`;
用 clean path + `curl -sL`(带 `.html` 会 307 跳转)。

## 回滚

```bash
vercel ls                                   # 找上一个 production 部署
vercel promote <上一个部署的 URL>            # 或 vercel redeploy <URL>
```

## 未演练

**尚未在一台空机上从零走过这套流程**(装 CLI、登录、拿到项目关联)。
按 §19,在隔离环境演练并把证据记进 `docs/tests/` 之前,**不得宣称"可恢复"** ——
当前地位是「已知正确的操作手册」。

其中**登录态与项目关联**是最大的未覆盖项:`.vercel/project.json` 里的
`projectId` / `orgId` 可以入库(不是密钥),但 CLI 的登录凭据不能,
只记录"需要有权限的账号登录"这一事实与获取方式。
