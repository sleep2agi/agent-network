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

# 项目关联与构建 env 都在 .vercel/ 里,从主 checkout 带过来
cp -r <主checkout>/docs-site/.vercel .vercel

# 复用已装好的依赖,省一次冷装
ln -sfn <主checkout>/docs-site/node_modules node_modules

# 🔴 本地先构建 —— ignoreDeadLinks 未设,有死链即 fail。
#    不要带着死链上线。
npm run build

# 🔴 产物必须在本地构建,再把**预构建产物**推上去。
#    绝不让 Vercel 远端构建 —— 那是一条成本红线(远端构建费用一个月到过 100 美元,#1163)。
vercel build --prod
vercel deploy --prebuilt --prod --yes

# 期望结尾: Aliased: https://www.anet.sh
# 🔴 而且日志里**必须**出现这一行,它就是「没走远端 build」的判据:
#      Building: Using prebuilt build artifacts from .vercel/output
#    没有它 = 这次走了远端构建 = 撞红线,要停下来查。
```

::: danger 不要用 `vercel --prod --yes`
这条命令**会让 Vercel 在云端重新构建一次** —— 它正是 #1163 立案要修的那条。

**实测 2026-08-30**:照本文件旧版本手工部署 4 次,**4 次全部走远端构建、0 次出现
prebuilt 标记**,而每次日志都在眼前。照文档做的人不会知道自己在烧钱 ——
所以这里把它写成明确的禁止,而不是只把正确写法放在上面。

自动化版本见 `.github/workflows/docs-site-deploy.yml`(合并进 main 即自动部署,
并把上面那条判据做成门)。
:::

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

其中**登录态**仍是未覆盖项:CLI 的登录凭据不能入库,
只记录"需要有权限的账号登录"这一事实与获取方式。

**项目关联已经入库了**(2026-08-27),见下一节 —— 那一半的 bus-factor 已经消掉。

## 恢复项目关联

`docs-site/.vercel/` 被 gitignore(**那条 ignore 是安全属性,别为了这三个字段撤掉它** ——
它挡的是 `vercel link` 之后把登录态之类的东西顺手提交进来)。
所以项目关联单独存在 [`vercel-project.json`](./vercel-project.json):

```bash
mkdir -p docs-site/.vercel
python3 - <<'EOF'
import json
src = json.load(open('deploy/docs-site/vercel-project.json'))
json.dump({k: src[k] for k in ('projectId', 'orgId', 'projectName')},
          open('docs-site/.vercel/project.json', 'w'), indent=2)
EOF
```

之后 `vercel build --prod` / `vercel deploy --prebuilt --prod` 就能认到项目;**登录仍需一个有权限的账号**(`vercel login`)。

🔴 **那三个字段不是密钥** —— 没有 Vercel token,它们不授予任何权限。
入库的理由是降 bus-factor:在此之前**项目关联只存在于某一台机器上**,
跟"部署要靠某个人记得跑"是同一个单点,而这一半**不需要任何 Vercel 权限就能修**。

🔴 **只收录不透明 ID,不收录 CLI 输出里那个组织 slug** —— 那个 slug 含人名,
两个 ID 不含。降 bus-factor 不必以新增一处真实标识为代价。
