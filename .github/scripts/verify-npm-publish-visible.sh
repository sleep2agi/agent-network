#!/usr/bin/env bash
# 发后核实:npm publish 返回成功之后,轮询 registry,直到
#   (a) dist-tags.preview == 期望版本,且
#   (b) versions[期望版本].dist.shasum == CI tarball 的 sha1
# 两条同时成立才算通过。
#
# 🔴 为什么要轮询(#582):
#   npm publish 成功 ≠ registry 立即可见。2026-10-05 一天里三次成功的发布
#   (Hub 0.9.0-preview.104 / agent-node 2.5.0-preview.111 / agent-network 2.3.0-preview.144)
#   被原来「6 次、共约 1.5 分钟」的核实判成「发布没生效」—— 最后那次 npm 自己打印了
#   "Your package is being processed and may take a few minutes to become available"。
#   provenance 发布历史上最长约 6 小时才可见。「没生效」那句在 npm 已接受时是假话,
#   而假红会诱导人重发同一个版本号(npm 会回 E409 previously staged)。
#
# 判定三分(措辞必须能区分):
#   - 通过:版本可见且 shasum 相符(tag 落后只 warning,由显式 dist-tag 收口) → rc 0
#   - 字节不符:版本已可见但 shasum ≠ 本地 tarball                  → 立即 rc 1,不轮询
#   - 超时:npm 已接受,但 N 分钟内 registry 上还看不到              → rc 1(未核实 ≠ 没生效)
#
# 输入(环境变量):
#   PKG                    包名(必填)
#   EXPECTED               期望版本(必填)
#   TARBALL                CI 打的 tarball 路径(与 LOCAL_SHA1 二选一)
#   LOCAL_SHA1             直接给 sha1(测试用)
#   VERIFY_TIMEOUT_MIN     轮询上限,分钟,默认 15
#   VERIFY_TIMEOUT_S       轮询上限,秒(给了就覆盖 MIN;测试用)
#   VERIFY_INTERVAL_S      两次检查间隔,秒,默认 25
#   NPM_REGISTRY_URL       默认 https://registry.npmjs.org
#
# 读的是 registry 本身(curl),不是 `npm view` —— 后者读 CDN 缓存,
# 2026-08-27 agent-network@2.3.0-preview.48 就因此误判过一次。
set -euo pipefail

: "${PKG:?PKG 必填}"
: "${EXPECTED:?EXPECTED 必填}"
registry="${NPM_REGISTRY_URL:-https://registry.npmjs.org}"
interval="${VERIFY_INTERVAL_S:-25}"
timeout_min="${VERIFY_TIMEOUT_MIN:-15}"
timeout_s="${VERIFY_TIMEOUT_S:-$((timeout_min * 60))}"

if [ -z "${LOCAL_SHA1:-}" ]; then
  : "${TARBALL:?TARBALL 或 LOCAL_SHA1 必填}"
  LOCAL_SHA1=$(sha1sum "$TARBALL" | cut -d" " -f1)
fi
echo "核实 $PKG@$EXPECTED:本地 tarball sha1=$LOCAL_SHA1;最长等 ${timeout_s}s,每 ${interval}s 查一次"

# 解析 registry 文档 → 输出一行 "<preview tag>\t<versions[EXPECTED].dist.shasum>"
parse() {
  V="$EXPECTED" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    let tag="", sha="";
    try {
      const d=JSON.parse(s);
      tag=(d["dist-tags"]||{}).preview||"";
      sha=(((d.versions||{})[process.env.V]||{}).dist||{}).shasum||"";
    } catch {}
    console.log(tag+"\t"+sha);
  });'
}

start=$SECONDS
attempt=0
tag=""; reg_sha=""
while :; do
  attempt=$((attempt + 1))
  # 先收进变量再解析:不让 curl 的退出码穿过管道(CLAUDE.md ②)
  doc=$(curl -fsSL --max-time 20 -H 'Cache-Control: no-cache' "$registry/$PKG" 2>/dev/null) || doc=""
  line=$(printf '%s' "$doc" | parse)
  tag=${line%%$'\t'*}
  reg_sha=${line#*$'\t'}
  elapsed=$((SECONDS - start))
  echo "attempt $attempt (+${elapsed}s): preview=${tag:-<读不到>} shasum[$EXPECTED]=${reg_sha:-<尚不可见>}"

  # 已可见但字节不符:这不是「还没传播」,等多久都不会变 —— 立即红。
  if [ -n "$reg_sha" ] && [ "$reg_sha" != "$LOCAL_SHA1" ]; then
    echo "::error::字节不符:registry 上 $PKG@$EXPECTED 的 shasum=$reg_sha,而 CI tarball 的 sha1=$LOCAL_SHA1 —— 发出去的不是门验过的那份"
    exit 1
  fi

  # 判据分两层,故意**不**把两件事捆成一票否决:
  #   ① 这个版本可见 + shasum 与 CI tarball 一致  → 这是「发出去没有」,必须绿;
  #   ② dist-tags.preview 指向这个版本            → 这是「@preview 装哪个」,由 publish job
  #      后面的「收口 dist-tag:preview」那一步显式设置并回读。
  # 🔴 为什么不能把 ② 并进 ①(2026-11-10 实测):`npm publish --tag preview` 的 tag 是一个
  #    异步处理的副作用,tag 可能**落后于**版本可见性(225 实测:版本 200 可见、tag 还停在 224),
  #    也可能一直没跟上;而连续发两个包时,较老那版的 tag 断言**永远不可能满足**(tag 会被更晚的
  #    版本拿走) ⇒ 旧判据会让一个「字节已经正确落地」的发布白等超时后判红,人就会去重发,
  #    撞 E409 previously staged。tag 由显式动作负责,不靠这里猜。
  if [ "$reg_sha" = "$LOCAL_SHA1" ]; then
    if [ "$tag" = "$EXPECTED" ]; then
      echo "✅ registry 已可见:preview=$tag,shasum 与 CI tarball 一致(用时 ${elapsed}s,第 $attempt 次)"
    else
      echo "::warning::版本与字节都对上了(preview 目前是 ${tag:-<读不到>},不是 $EXPECTED)—— tag 会滞后于可见性,不判红;由后续「收口 dist-tag:preview」显式设置并回读。"
      echo "✅ registry 已可见:$PKG@$EXPECTED,shasum 与 CI tarball 一致(用时 ${elapsed}s,第 $attempt 次)"
    fi
    exit 0
  fi

  if [ "$elapsed" -ge "$timeout_s" ]; then
    break
  fi
  sleep "$interval"
done

echo "::error::尚未核实(不是发布被拒):npm publish 已返回成功(见上一步「npm publish --tag preview」的输出),但等了 ${timeout_s}s 后 registry 上仍看不到 —— 最后一次读到 preview=${tag:-<读不到>},$EXPECTED 的 shasum=${reg_sha:-<尚不可见>}"
echo "它可能稍后才出现(npm 处理 provenance 发布历史上最长约 6 小时)。稍后用下面的命令核对,应等于 $LOCAL_SHA1:"
echo "    npm view $PKG@$EXPECTED dist.shasum"
echo "    npm view $PKG dist-tags.preview"
echo "🔴 不要重发同一个版本号 —— npm 会回 E409 previously staged,还会白白烧掉这个号。"
exit 1
