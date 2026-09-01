#!/usr/bin/env bash
# 把 docs-site-drift 的结果送到人眼前 —— 而不是只在 Actions 里变红。
#
# ## 为什么需要它
#
# `check-docs-site-drift.py` 判定一直是对的,问题在**没有任何渠道**能让它的结论
# 到达人:**那道门连红 8 天没人动**(2026-08-19 ~ 08-27)。
# ⇒ 「Actions 里变红」**已被实测证明不是一个通知渠道**。
#
# 而这道门红了指向的动作是唯一且明确的(从 origin/main 的 worktree 跑
# `vercel deploy --prebuilt --prod`),所以它值得被送出来。
#
# ## 判据:一条 tracker issue,开/更新/关,不刷屏
#
# 定时每天跑一次 ⇒ 若每次红都新开一条,8 天就是 8 条。
# 用 body 里的隐藏标记找那条已存在的 issue,有则更新、无则新建;绿了则关掉。
#
# ## 🔴 rc=1 与 rc=2 必须给不同的话
#
#   rc=1  站点落后于 main          → 动作:部署
#   rc=2  取不到/量不了(网络等)     → 动作:去查为什么量不了,**不是**去部署
#
# 这两个在原来的实现里都会走 `exit 2 refusing to pass`,把真漂移报成基础设施故障;
# #1238 把它们分开了。通知这一层**不能把它们又合回去** —— 对着一个量不出来的站点
# 喊"快去部署"是**假指令**,而人会照做。
#
# ## 这一层不改判定
#
# 通知是附加的:job 的红/绿仍由脚本自己的退出码决定(workflow 里最后一步重放它)。
set -uo pipefail

MARK='<!-- docs-site-drift-tracker -->'
OUT="${DRIFT_OUT:-drift.out}"
RC="${RC:-1}"
REPO="${GITHUB_REPOSITORY:-sleep2agi/agent-network}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${GITHUB_RUN_ID:-0}"

find_tracker() {
  gh issue list --repo "$REPO" --state open --search "\"docs-site-drift-tracker\" in:body" \
     --json number --jq '.[0].number // empty' 2>/dev/null
}

body_for() {
  local rc="$1" detail="$2"
  printf '%s\n\n' "$MARK"
  if [ "$rc" = "1" ]; then
    cat <<EOF
**anet.sh 落后于 \`main\`。** 这道门检查的是**已部署的站点**,不是仓库内容 ——
所以它红了不代表有人写错了什么,而是**合并之后没有人跑部署**。

anet.sh 没有接 git 自动部署:**合并进 main 不会让站点更新**。

### 要做的事(唯一且明确)

\`\`\`bash
git fetch origin main
git worktree add --detach /tmp/anet-site origin/main
cd /tmp/anet-site/docs-site
cp -r <主checkout>/docs-site/.vercel .vercel
ln -sfn <主checkout>/docs-site/node_modules node_modules
npm run build          # ignoreDeadLinks 未设,有死链会 fail —— 别带着死链上线
# 🔴 必须走预构建:绝不让 Vercel 远端 build(成本红线 #1163)
vercel build --prod
# 🔴 --scope 不能少:登录身份默认是**个人**作用域,而 .vercel/project.json 的
#    orgId 是 team_…。不带 scope 时 vercel deploy 直接返回 Not authorized ——
#    读起来像没权限,其实是找错了作用域。团队 id 用 `vercel teams ls` 查。
vercel deploy --prebuilt --prod --yes --scope <vercel-team>
# 期望 Aliased: https://www.anet.sh
# 🔴 且日志里必须出现 Using prebuilt build artifacts —— 没有它就是走了远端构建
\`\`\`

### 验收:验内容,不验状态码

\`200\` 只说明站点活着。\`age:\` 头**两个方向都偏向「已经好了」**,不能当判据。
部署完重跑这道门,或直接抓刚改过的那句话:

\`\`\`bash
python3 .github/scripts/check-docs-site-drift.py
\`\`\`

详见 \`deploy/docs-site/README.md\`。
EOF
  else
    cat <<EOF
🔴 **这道门这次「量不出来」,不是「站点落后」。**

退出码 \`$rc\` 的含义是**取不到样本 / 抓不到页面**(网络、站点不可达、采样集塌了)——
**不要据此去部署**。对着一个量不出来的站点部署,既修不了问题,也会把
「我们其实不知道现状」这件事掩盖掉。

### 要做的事

先弄清**为什么量不了**,再决定要不要部署。
EOF
  fi
  printf '\n### 本次输出\n\n```\n%s\n```\n\n[完整 run](%s)\n' "$detail" "$RUN_URL"
  printf '\n---\n*这条 issue 由 `docs-site-drift` 自动开/更新;门变绿时它会自动关闭。*\n'
}

detail="$( [ -f "$OUT" ] && tail -c 3000 "$OUT" || echo '(no output captured)' )"
tracker="$(find_tracker)"

if [ "$RC" = "0" ]; then
  if [ -n "$tracker" ]; then
    gh issue comment "$tracker" --repo "$REPO" \
      --body "✅ 门已变绿:anet.sh 上的采样页面与 \`main\` 一致。自动关闭。

[完整 run]($RUN_URL)"
    gh issue close "$tracker" --repo "$REPO" >/dev/null
    echo "closed tracker #$tracker (gate green)"
  else
    echo "gate green, no tracker open — nothing to do"
  fi
  exit 0
fi

title="$( [ "$RC" = "1" ] && echo '[docs-site-drift] anet.sh 落后于 main —— 需要有人跑一次部署' \
                          || echo "[docs-site-drift] 这道门量不出来(exit $RC) —— 先查为什么" )"

if [ -n "$tracker" ]; then
  body_for "$RC" "$detail" > /tmp/drift-body.md
  gh issue edit "$tracker" --repo "$REPO" --title "$title" --body-file /tmp/drift-body.md >/dev/null
  gh issue comment "$tracker" --repo "$REPO" --body "🔁 仍未解决(exit \`$RC\`)。已更新正文为最新一次结果。

[完整 run]($RUN_URL)"
  echo "updated tracker #$tracker"
else
  body_for "$RC" "$detail" > /tmp/drift-body.md
  n="$(gh issue create --repo "$REPO" --title "$title" --body-file /tmp/drift-body.md \
       --json number --jq .number 2>/dev/null || gh issue create --repo "$REPO" \
       --title "$title" --body-file /tmp/drift-body.md)"
  echo "opened tracker: $n"
fi
