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
curl -sL https://anet.sh/<某个刚改过的页面> | grep '<刚写的那句话>'   # ← 唯一可靠的那条
```

🔴 **不要用 `age:` 头当判据。** 这份文档原来建议 `curl -sI | grep '^age:'`(「age 很大 =
很久没部署」)—— **实测不成立**。同一时刻抓三个页面:

```
/                    age: 442813   （5.13 天)
/deploy/npm          age: 212508   （2.46 天)
/concepts/security   age:    285   （4.75 分钟)
```

`age` 是 **CDN 上那个对象的缓存年龄**,不是部署年龄;**任何人**最近访问过某页都会把它
清零 —— 包括你自己刚才为了检查而发的那次请求。

**它的偏差方向是「让很旧的站点看起来很新」** ⇒ 拿它自检,**漏报是默认结果**。
留着它作为「顺手一看」可以,**但不能拿它下结论**。

自动化版本见 `.github/scripts/check-docs-site-drift.py`(每日定时跑):它从**最近新增的
行**里取指纹,再抓线上那一页比对 —— 指纹必须来自新增行,否则会挑到新旧版本都有的句子
而误报"没问题"(第一版就是这么错的,6 个采样页有 5 个假 ok)。

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

# 只复制项目关联与构建 env。不要复制 `.vercel/output`:主 checkout 里可能
# 留着别的 commit 的陈旧预构建产物,`--prebuilt` 会把它当成真的部署。
mkdir -p .vercel
cp <主checkout>/docs-site/.vercel/project.json .vercel/project.json
cp <主checkout>/docs-site/.vercel/.env.production.local .vercel/.env.production.local

# 依赖必须属于这个 worktree。不要软链别的检出的 node_modules:`npm ci`
# 会删除并重建目标目录,软链会让本 worktree 破坏另一个检出。
npm ci

# 🔴 本地先构建 —— ignoreDeadLinks 未设,有死链即 fail。
#    不要带着死链上线。
npm run build

# 🔴 成本红线:只上传本地预构建产物,绝不让 Vercel 远端重新构建。
vercel build --prod
vercel deploy --prebuilt --prod
# 期望结尾: Aliased: https://www.anet.sh
```

部署日志应只有读取/上传 `.vercel/output` 与 alias 的过程,不应再次出现
`npm install`、`npm ci` 或 VitePress 的构建输出。若出现远端依赖安装或构建,
立即停止并检查是否漏了 `--prebuilt`;不要改用 `vercel --prod --yes` 绕过。

## 验证:验内容,不验状态码

`200` 只说明站点活着,不说明**你的改动上线了**。

```bash
curl -sL https://anet.sh/<页面> | grep '<本次新增的那句话>'  # 必须命中
curl -sL https://anet.sh/en/<页面> | grep '<英文那句>'      # 中英两套都要验
```

🔴 **指纹要用「本次新增的那句话」,不能用页面里随便一句。** 一句新旧版本都有的话,
线上当然找得到 —— 那证明不了新版本上线了,只证明这一页存在。
`check-docs-site-drift.py` 的第一版就是这么错的:6 个采样页报了 5 个 ok,而其中至少
两页当时确实缺了新内容。

🔴 **这里原本还有一行 `grep -i '^age:'  # 期望 age: 0(刚部署)`,已删。**
理由和本文开头那条一样,而且**用在部署之后更容易骗人**:`age: 0` 只说明**这个边缘节点
手上没有缓存副本**,不说明它拿到的是新版本 —— 命中一个还没被人访问过的边缘节点,
即使部署失败也会给你 `age: 0`。**它的两个方向都偏向「已经好了」。**

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
