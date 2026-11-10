#!/usr/bin/env bash
# #1510 续：`npm publish` 退出码 1 ≠ 没发出去。
#
# 现场（2026-10-29，`0.9.0-preview.203`）：
#
#     npm error code TLOG_CREATE_ENTRY_ERROR
#     npm error error creating tlog entry - (409) an equivalent entry already exists
#                in the transparency log
#     ##[error]Process completed with exit code 1.
#
# 而 registry 上版本其实已经有了（`preview` dist-tag 已指向 .203）。
# 后果比错误本身严重：publish 一 exit 1，后面那步「发后核实（轮询 registry 最长 45 分钟、
# 比对 tag 与 shasum）」**从来没跑**。于是「已发布」和「发布失败」在 CI 上都长成红色，
# 人看到红就重跑，重跑又撞同一个 409 —— 陷进一个和事实完全相反的循环。
#
# 这个脚本只改一件事：**失败时先分类**。
#   透明度日志冲突 ⇒ 不判死，退出 0，把「到底发没发出去」交给发后核实那一步
#   其它失败       ⇒ 原样返回退出码（鉴权、2FA、网络、空间不足……）
#
# 判据唯一归口：verify-npm-publish-visible.sh 会轮询 registry 并比对 tag + shasum。
# 在这里自己再查一次 registry 只是同一件事判两遍，而且判得更粗。
#
# 用法: publish-with-tlog-recover.sh <tarball> [tag]     （默认 tag=preview）
set -euo pipefail

TARBALL="${1:?用法: publish-with-tlog-recover.sh <tarball> [tag]}"
TAG="${2:-preview}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$(mktemp)"

set +e
npm publish "$TARBALL" --tag "$TAG" --provenance --access public 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e

if [ "$rc" -eq 0 ]; then
  exit 0
fi

echo "npm publish 退出码 $rc —— 先判这是不是「透明度日志已记录」这一类"
# 注意：必须用 if，不能「跑完再看 $?」—— 脚本带 set -e，python 非零退出的那一刻
# 会把整个脚本掐掉，那就等于又回到「只看退出码」。
if python3 "$SCRIPT_DIR/publish-outcome.py" --log "$LOG"; then
  echo "::notice::透明度日志已记录这次发布（409 的语义是「已记过」，不是「被拒绝」）"
  echo "::notice::成败交给后面的「发后核实」：它轮询 registry 最长 45 分钟并比对 tag 与 shasum"
  exit 0
fi

echo "::error::npm publish 真失败（退出码 $rc）"
exit "$rc"
