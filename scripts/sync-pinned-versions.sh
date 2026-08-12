#!/usr/bin/env bash
# sync-pinned-versions.sh — 跨包 release 时同步 PINNED 版本号
#
# 用法:
#   ./scripts/sync-pinned-versions.sh <pkg-name> <new-version>            # dry-run (默认)
#   ./scripts/sync-pinned-versions.sh <pkg-name> <new-version> --apply    # 实跑
#
# 支持的 pkg-name:
#   @sleep2agi/agent-network
#   @sleep2agi/agent-node
#   @sleep2agi/commhub-server
#   @sleep2agi/agent-network-dashboard
#
# 例子:
#   ./scripts/sync-pinned-versions.sh @sleep2agi/agent-node 2.3.2-preview.0
#   ./scripts/sync-pinned-versions.sh @sleep2agi/agent-node 2.3.2-preview.0 --apply
#
# 详见 docs/RELEASE-SOP.md。

set -euo pipefail

# ---------- args ----------

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <pkg-name> <new-version> [--apply]" >&2
  echo "       (默认 dry-run；--apply 才实写文件)" >&2
  exit 2
fi

PKG="$1"
NEW_VERSION="$2"
MODE="dry-run"
if [[ "${3:-}" == "--apply" ]]; then
  MODE="apply"
fi

# ---------- repo root ----------

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "ERROR: 必须在 git 仓库内运行" >&2
  exit 3
fi
cd "$REPO_ROOT"

# ---------- 版本号格式校验 ----------

# 允许 X.Y.Z 或 X.Y.Z-tag.N（preview / alpha / rc 等）
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+\.[0-9]+)?$ ]]; then
  echo "ERROR: 版本号格式不合法: $NEW_VERSION" >&2
  echo "       期望 X.Y.Z 或 X.Y.Z-tag.N (如 2.3.2-preview.0)" >&2
  exit 4
fi

# ---------- pkg → files map ----------
#
# Live versions：每次 release 必须 sync 的位置。
# Frozen snapshots（changelog / archive / v0.8.0/）永不进入这里。
#
# 维护规则：以后哪个文件加了 hardcoded 版本，新增一行 `register <pkg> <file>` 即可。

ENTRIES=()

register() {
  ENTRIES+=("$1|$2")
}

# @sleep2agi/agent-network — 用户安装入口
register "@sleep2agi/agent-network" "docs-site/docs/guide/runtimes.md"
register "@sleep2agi/agent-network" "docs-site/docs/en/guide/runtimes.md"
register "@sleep2agi/agent-network" "agent-network/src/opencode-agent-node-pair.ts:OPENCODE_AGENT_NETWORK_VERSION"

# @sleep2agi/agent-node — runtime + SDK 行号锚点
register "@sleep2agi/agent-node" "docs-site/docs/guide/runtimes.md"
register "@sleep2agi/agent-node" "docs-site/docs/en/guide/runtimes.md"
register "@sleep2agi/agent-node" "docs-site/docs/guide/agent-node.md"
register "@sleep2agi/agent-node" "docs-site/docs/en/guide/agent-node.md"
register "@sleep2agi/agent-node" "docs-site/docs/guide/sdk-deep-dive.md"
register "@sleep2agi/agent-node" "docs-site/docs/en/guide/sdk-deep-dive.md"
register "@sleep2agi/agent-node" "agent-network/src/opencode-agent-node-pair.ts:OPENCODE_AGENT_NODE_VERSION"

# @sleep2agi/commhub-server — agent-network CLI 内 PINNED_SERVER_VERSION 常量
register "@sleep2agi/commhub-server" "agent-network/bin/cli.ts:PINNED_SERVER_VERSION"

# @sleep2agi/agent-network-dashboard — agent-network CLI 内 PINNED_DASHBOARD_VERSION 常量
register "@sleep2agi/agent-network-dashboard" "agent-network/bin/cli.ts:PINNED_DASHBOARD_VERSION"

# ---------- 收集目标 ----------

TARGETS=()
for entry in "${ENTRIES[@]}"; do
  e_pkg="${entry%%|*}"
  e_target="${entry#*|}"
  if [[ "$e_pkg" == "$PKG" ]]; then
    TARGETS+=("$e_target")
  fi
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "ERROR: 未识别的 pkg-name: $PKG" >&2
  echo "       支持: @sleep2agi/agent-network | agent-node | commhub-server | agent-network-dashboard" >&2
  exit 5
fi

# ---------- helpers ----------

# 转义 sed 替换串里的特殊字符（这里只可能出现数字、点、字母、短横线，安全，但保险）
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

ESCAPED_VERSION="$(sed_escape "$NEW_VERSION")"

CHANGED_FILES=()
# 注册表里"已不存在的目标"计数;>0 时脚本以非零退出,让漂移可见而不是静默。
MISSING_TARGETS=0

# md / ts 通用模板：把 `@sleep2agi/<pkg>@<old>` 替换成新版本。
# pkg 字面值不带尾随字符歧义（agent-network vs agent-network-dashboard），所以加 `[^a-zA-Z0-9_-]`
# 边界保护，避免 agent-network 误替到 agent-network-dashboard。
md_pattern() {
  local pkg_no_scope="${PKG#@sleep2agi/}"
  # 匹配 @sleep2agi/<pkg>@<X.Y.Z[-tag.N]>，后接非版本字符（防短前缀串到长前缀）
  printf 's#\\(@sleep2agi/%s\\)@[0-9][0-9A-Za-z.-]*\\([^0-9A-Za-z.-]\\|$\\)#\\1@%s\\2#g' \
    "$pkg_no_scope" "$ESCAPED_VERSION"
}

# PINNED 常量模板：仅替换 `const NAME = "..."` 或
# `export const NAME = "..."` 的字串字面值。
# 不动 declaration 周围 logic、不动 NAME 之外的同字串引用、不改类型/作用域
ts_pinned_pattern() {
  local const_name="$1"
  # 严格锚定可选 export + `const <NAME> = "x.y.z..."`，保留其它内容。
  printf 's#\\(\\(export \\)\\?const %s = \\)"[^"]*"#\\1"%s"#g' \
    "$const_name" "$ESCAPED_VERSION"
}

# 在 dry-run 时打印 diff，在 apply 时实写
apply_or_preview() {
  local file="$1"
  local sed_expr="$2"
  if [[ ! -f "$file" ]]; then
    echo "  SKIP (不存在): $file"
    return
  fi
  local before
  # Command substitution strips trailing newlines. Append a sentinel before
  # capture, then remove only that sentinel so a release sync never changes
  # the target file's EOF shape as a side effect.
  before="$(cat "$file"; printf '\036')"
  before="${before%$'\036'}"
  local after
  after="$(sed "$sed_expr" "$file"; printf '\036')"
  after="${after%$'\036'}"
  if [[ "$before" == "$after" ]]; then
    # 🔴 "无变化" 有两种完全不同的原因,旧版把它们混成同一行 `unchanged:`:
    #   (a) 目标在,且已经是目标版本            → 真的没事
    #   (b) 目标**根本不在这个文件里**(被删/改名) → 注册表已与现实脱节
    # (b) 读起来像 (a),于是这份清单会静默失去覆盖 —— 而 RELEASE-SOP
    # 恰恰让人把它当作"硬编码版本位"的权威枚举。实例:
    # `agent-network/bin/cli.ts:PINNED_DASHBOARD_VERSION` 已从 cli.ts 消失,
    # 但注册表里还留着,同步时只会打印一行 unchanged。
    if [[ -n "${3:-}" ]] && ! grep -q "const ${3} = " "$file"; then
      echo "  🔴 MISSING TARGET: $file 里找不到 \`const ${3} = ...\` —— 注册表已过期"
      MISSING_TARGETS=$((MISSING_TARGETS + 1))
      return
    fi
    echo "  unchanged: $file"
    return
  fi
  if [[ "$MODE" == "apply" ]]; then
    printf '%s' "$after" > "$file"
    echo "  WROTE: $file"
    CHANGED_FILES+=("$file")
  else
    echo "  WOULD-WRITE: $file"
    diff -u <(printf '%s' "$before") <(printf '%s' "$after") | sed 's/^/    /' | head -40
  fi
}

# ---------- 执行 ----------

echo "============================================================"
echo "  sync-pinned-versions.sh"
echo "  pkg     : $PKG"
echo "  version : $NEW_VERSION"
echo "  mode    : $MODE"
echo "  repo    : $REPO_ROOT"
echo "============================================================"

for target in "${TARGETS[@]}"; do
  if [[ "$target" == *":"* ]]; then
    # cli.ts:CONST_NAME 形式
    file="${target%%:*}"
    const_name="${target#*:}"
    echo ""
    echo "[$PKG → $file ($const_name)]"
    apply_or_preview "$file" "$(ts_pinned_pattern "$const_name")" "$const_name"
  else
    echo ""
    echo "[$PKG → $target]"
    apply_or_preview "$target" "$(md_pattern)"
  fi
done

echo ""
echo "============================================================"

# ---------- summary ----------

if [[ "$MODE" == "apply" ]]; then
  if [[ ${#CHANGED_FILES[@]} -eq 0 ]]; then
    echo "完成。无文件改动（pkg 当前版本可能已经是 $NEW_VERSION）。"
  else
    echo "完成。改动文件 ${#CHANGED_FILES[@]} 个："
    for f in "${CHANGED_FILES[@]}"; do echo "  - $f"; done
    echo ""
    echo "下一步: 跑 'git diff' review，确认改动后再 commit。"
    echo "git diff --stat 摘要："
    git diff --stat -- "${CHANGED_FILES[@]}" || true
  fi
else
  echo "dry-run 完成。如果上面 diff 看着对，加 --apply 实跑。"
  echo "  ./scripts/sync-pinned-versions.sh $PKG $NEW_VERSION --apply"
fi

# 注册表与现实脱节时以非零退出。理由:RELEASE-SOP 让人把这份注册表当作
# "硬编码版本位"的权威枚举,所以它失去覆盖必须是**可见**的,而不是一行
# 读起来像"已经是对的"的 unchanged。
if [[ "$MISSING_TARGETS" -gt 0 ]]; then
  echo ""
  echo "🔴 $MISSING_TARGETS 个注册目标在文件里已不存在 —— 这份注册表不再覆盖它们。"
  echo "   要么把常量改回来,要么从本脚本顶部的 register 区删掉那一行。"
  echo "   在此之前不要把本脚本的输出当作'所有版本位都已同步'的证据。"
  exit 6
fi
