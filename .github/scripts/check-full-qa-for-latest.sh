#!/usr/bin/env bash
# 升 latest 前的全量测试闸:这个版本的源码,在 main 上跑过的全量 QA 矩阵是不是绿的。
#
# 分层(2026-11-10 Vincent 定):
#   · preview —— release.yml 只跑快速门(install smoke / pin / release notes / doc claims),
#                PR 上已经跑过 unit + doc 层;不等全量矩阵。
#   · latest  —— 本闸:要求 qa.yml 全量矩阵(schedule / workflow_dispatch,即 `full=true`)
#                在包含该版本源码的 main 提交上是绿的。
#
# 判据:
#   1. 源 commit 取自 npm 上该版本的 SLSA provenance(由 registry 签名绑定,不信人填的输入),
#      并要求它来自本仓 .github/workflows/release.yml。
#   2. 在 qa.yml 的 main 全量运行里,取**最早**一个 head 包含该 commit 的已完成运行。
#      最早 = 离这个版本最近的快照;之后的红/绿混入了版本之外的改动,不能替它作证。
#   3. 它必须是 success。cancelled 不算数(跳过);其余结论一律判红。
#      flaky 的红:在 Actions 里 re-run 那次运行,结论会更新。
#
# 输入(环境变量):
#   PKG               完整包名,如 @sleep2agi/agent-network(必填)
#   VERSION           要升的版本(必填)
#   REPO              owner/name(必填)
#   NPM_REGISTRY_URL  默认 https://registry.npmjs.org
# 依赖:curl、node、gh(已认证)、git(当前目录是本仓的完整克隆)
#
# 退出码:0 = 有覆盖且为绿 | 1 = 没有覆盖 / 覆盖为红 / 拿不到源 commit | 2 = 用法错误
set -euo pipefail

usage_error() { echo "::error::$1" >&2; exit 2; }
[ -n "${PKG:-}" ] || usage_error 'PKG 必填'
[ -n "${VERSION:-}" ] || usage_error 'VERSION 必填'
[ -n "${REPO:-}" ] || usage_error 'REPO 必填'
case "$PKG" in @*/*) ;; *) usage_error "PKG='$PKG' 不是作用域包名(@scope/name)" ;; esac

registry="${NPM_REGISTRY_URL:-https://registry.npmjs.org}"
enc=${PKG//\//%2f}

att=$(curl -fsSL --max-time 30 "$registry/-/npm/v1/attestations/$enc@$VERSION" 2>/dev/null) || att=""
src=$(printf '%s' "$att" | REPO="$REPO" node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try {
      const a=JSON.parse(s).attestations.find(x=>/slsa\.dev\/provenance/.test(x.predicateType));
      const st=JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload,"base64").toString());
      const bd=st.predicate.buildDefinition;
      const wf=bd.externalParameters.workflow;
      if (wf.repository!=="https://github.com/"+process.env.REPO || wf.path!==".github/workflows/release.yml") {
        console.log("BAD\t"+wf.repository+"/"+wf.path); return;
      }
      const c=bd.resolvedDependencies[0].digest.gitCommit;
      console.log(/^[0-9a-f]{40}$/.test(c) ? "OK\t"+c : "BAD\tgitCommit="+c);
    } catch { console.log("NONE\t"); }
  });')
kind=${src%%$'\t'*}
commit=${src#*$'\t'}
case "$kind" in
  OK) ;;
  BAD)
    echo "::error::$PKG@$VERSION 的 provenance 不是本仓 release.yml 构建的($commit)—— 拒绝升 latest"
    exit 1 ;;
  *)
    echo "::error::取不到 $PKG@$VERSION 的 SLSA provenance —— 无法确定它的源 commit,也就无法确认全量测试覆盖过它"
    exit 1 ;;
esac
echo "$PKG@$VERSION 的源 commit(provenance):$commit"

if ! git cat-file -e "$commit^{commit}" 2>/dev/null; then
  git fetch --no-tags -q origin +refs/heads/main:refs/remotes/origin/main || true
fi
git cat-file -e "$commit^{commit}" 2>/dev/null \
  || { echo "::error::本地克隆里没有源 commit $commit(不在 main 上?)"; exit 1; }

# 新→旧;只要 main 上的全量运行(PR 上是快速层,不算)
runs=$(gh api "repos/$REPO/actions/workflows/qa.yml/runs?branch=main&status=completed&per_page=100" \
  --jq '.workflow_runs[] | select(.event=="schedule" or .event=="workflow_dispatch") | [.head_sha, .conclusion, .html_url] | @tsv') \
  || { echo "::error::读不到 qa.yml 的运行记录(gh api 失败)"; exit 1; }

pick=""
while IFS=$'\t' read -r sha conclusion url; do
  [ -n "$sha" ] || continue
  [ "$conclusion" = cancelled ] && continue
  git cat-file -e "$sha^{commit}" 2>/dev/null || continue
  if git merge-base --is-ancestor "$commit" "$sha"; then
    pick="$sha"$'\t'"$conclusion"$'\t'"$url"
  else
    break
  fi
done <<< "$runs"

if [ -z "$pick" ]; then
  echo "::error::main 上还没有覆盖 $commit 的全量 QA 运行(qa.yml,schedule / workflow_dispatch)。"
  echo "先在 Actions 里对 main 手动跑一次 'anet QA (v0)'(workflow_dispatch),绿了再升 latest;或等夜间那次。"
  exit 1
fi

IFS=$'\t' read -r sha conclusion url <<< "$pick"
echo "最早覆盖该版本的全量 QA:$url(head=$sha,结论=$conclusion)"
if [ "$conclusion" != success ]; then
  echo "::error::覆盖 $PKG@$VERSION 的全量 QA 是 $conclusion —— 正式版要求全量矩阵绿。修好后发新的 preview 再升;若是 flaky,re-run 那次运行。"
  exit 1
fi
echo "✅ 全量 QA 覆盖且为绿"
