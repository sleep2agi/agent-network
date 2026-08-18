#!/usr/bin/env bash
# 部署副本有没有跟仓库漂移。在**主机上**跑,不是在 CI 里 —— CI 看不到 ~/.local/bin。
#
# 为什么需要它:
#
# deploy/fleet/README.md 的安装步骤里本来就有这条校验:
#
#     test "$(git hash-object deploy/fleet/pm2-fleet-boot.sh)" = \
#          "$(git hash-object "$HOME/.local/bin/pm2-fleet-boot.sh")"
#
# 🔴 但它只在**安装的那一刻**跑一次,所以它只能证明「装的那一刻是对的」——
#    它管不住之后任何一次手改。
#
# 2026-08-18 在生产主机上跑本脚本的判据,4 对里 1 对不一致:
#
#     🔴 deploy/fleet/pm2-fleet-boot.sh   仓=ba9f214f  机器=a667de68
#     ✅ deploy/fleet/pm2-fleet.service
#     ✅ deploy/hub/hub-daemon.sh
#     ✅ deploy/dashboard/dash-start.sh
#
#    而且方向是反的:仓里那份**更新**、多一道 `pm2 jlist` 失败时拒绝 resurrect 的
#    fail-closed 护栏,机器上那份是 7 月 30 日的、没有。也就是说护栏写好了、提交了,
#    **但从来没有部署到会真正执行它的地方**。见 #839。
#
# 判据用的是仓库自己的那条(`git hash-object`),不是另造一个等价物 —— 结论谁都能
# 重跑,而且不依赖任何人对「什么算不同」的理解。
#
# 用法:
#     bash deploy/check-deployed-copies.sh          # 在仓库根目录跑
#     exit 0 = 全部一致 / 1 = 有漂移 / 2 = 无法判断(fail-closed)
#
# 🔴 它只报告,不修。把机器上的文件换成仓里的版本是一次真实运维动作 —— 它会改变
#    所有 pm2 托管进程的重启路径,需要人挑窗口,不该由一个检查脚本顺手做掉。

set -uo pipefail

# 每行:<仓库内路径>|<主机上的部署路径>
# 加新条目时:确认它确实是「安装时从仓库拷过去」的那类文件,而不是主机独有的状态。
MANIFEST=$(cat <<EOF
deploy/fleet/pm2-fleet-boot.sh|${HOME}/.local/bin/pm2-fleet-boot.sh
deploy/fleet/pm2-fleet.service|${HOME}/.config/systemd/user/pm2-fleet.service
deploy/hub/hub-daemon.sh|${HOME}/.local/bin/hub-daemon.sh
deploy/dashboard/dash-start.sh|${HOME}/.local/bin/dash-start.sh
EOF
)

if ! command -v git >/dev/null 2>&1; then
  echo "::error::git 不可用,无法计算 hash-object —— 拒绝通过"
  exit 2
fi
if [ ! -d .git ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "::error::不在 git 仓库里(请在仓库根目录跑)—— 拒绝通过"
  exit 2
fi

checked=0
drift=0
missing=0

while IFS='|' read -r repo host; do
  [ -z "${repo:-}" ] && continue
  if [ ! -f "$repo" ]; then
    # 仓库里那份不见了 = 清单过期或路径改了。这不是「一致」,是判不了。
    echo "::error::清单里的仓库文件不存在: $repo —— 清单过期,拒绝通过"
    exit 2
  fi
  checked=$((checked + 1))
  a=$(git hash-object "$repo")
  if [ ! -f "$host" ]; then
    missing=$((missing + 1))
    echo "::error::$repo 在主机上没有对应文件($host)。要么这台机器没装过这条链,要么路径变了。"
    continue
  fi
  b=$(git hash-object "$host")
  if [ "$a" != "$b" ]; then
    drift=$((drift + 1))
    echo "::error::$repo 与主机副本不一致"
    echo "    仓库: $a"
    echo "    主机: $b  ($host)"
    echo "    先看清楚方向再动:仓库那份可能比主机新(修好了没部署),也可能主机上被人手改过。"
    echo "    diff <(git show HEAD:$repo) $host"
  fi
done <<< "$MANIFEST"

if [ "$checked" -eq 0 ]; then
  echo "::error::清单为空,一个都没检查 —— 拒绝通过"
  exit 2
fi

echo "检查了 $checked 对部署副本;不一致 $drift 个,主机缺失 $missing 个"
if [ "$drift" -gt 0 ] || [ "$missing" -gt 0 ]; then
  exit 1
fi
echo "全部与仓库一致。"
exit 0
