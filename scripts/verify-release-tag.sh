#!/usr/bin/env bash
# 校验 release tag 真的指向【打包用的那个 commit】。
#
# 为什么需要这道门(tmwork 2026-08-12 实际事故):
#   `gh release create <tag>` 在 tag 不存在时,默认在 target_commitish(默认 main)
#   上建 tag。于是 tag `desktop-v1.20.8-alpha.12` 剥出 04a66b20(当时 main 的 head),
#   而实际构建 commit 是 6a3db442 —— 差 26 个 commit。
#
# 🔴 它不会报错:release 页面完全正常,安装包也是对的。
#   只有真去重建的时候才会发现 `git clone --branch <tag>` 拿到的不是构建那份代码。
#   而"凭 tag 能重建"正是所有人默认相信的假设 —— 这类缺陷只在灾难恢复时暴露。
#
# 用法: verify-release-tag.sh <repo> <tag> <构建用的完整 SHA>
set -uo pipefail

REPO="${1:?repo, e.g. owner/name}"
TAG="${2:?tag}"
BUILD_SHA="${3:?完整的构建 commit SHA}"

# 🔴 回读必须用【远端】,不要用本地 `git rev-parse <tag>`。
# 本地 tag 可能就是你自己刚建的那个,那样验的是自己写的东西。
peeled="$(git ls-remote "https://github.com/${REPO}.git" "refs/tags/${TAG}^{}" | cut -f1)"
[ -n "$peeled" ] || peeled="$(git ls-remote "https://github.com/${REPO}.git" "refs/tags/${TAG}" | cut -f1)"

if [ -z "$peeled" ]; then
  echo "FAIL: tag ${TAG} 在远端不存在(或无法读取)" >&2
  exit 1
fi

if [ "$peeled" != "$BUILD_SHA" ]; then
  echo "FAIL: tag 未绑定构建 commit" >&2
  echo "  tag ${TAG} 剥出 : ${peeled}" >&2
  echo "  实际构建 commit : ${BUILD_SHA}" >&2
  echo "  → 用 \`gh release create ${TAG} --target ${BUILD_SHA}\` 重建;--target 不可省。" >&2
  exit 1
fi

echo "PASS: ${TAG} -> ${peeled} == 构建 commit"
