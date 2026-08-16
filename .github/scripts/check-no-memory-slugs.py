#!/usr/bin/env python3
"""Block internal memory-slug references from leaking into public OSS files.

Why this guard exists
=====================
Some agents that work on this repo use a private file-based memory system
indexed by `[[short-kebab-name]]` slugs (e.g. `[[feedback_no_test_on_prod]]`).
Those slugs are agent-internal: they only resolve inside the agent's
private memory store and have no meaning to outside contributors. Each
leak makes the public OSS look like it has dangling links and reveals
internal process slang. release.yml has burned us once on this class
already (Vincent caught a "Co-Authored-By: Claude" leak twice; the slug
shape is the same failure mode — internal artefact escaping to OSS via
auto-generated content).

What this checks
================
Scans the source tree for the pattern `[[<type>_<slug>]]` where `<type>`
is one of the four agent-memory categories: `feedback`, `project`,
`reference`, `user`. The matcher requires the leading double-bracket so
ordinary markdown reflinks `[label][ref]` don't false-positive.

Skipped paths
=============
- `node_modules/`, `dist/`, `build/`, `coverage/` — generated/vendored
- `.git/` — VCS metadata
- `.claude/`, `~/.claude/`, `memory/` — these ARE the memory store
- This script itself + its workflow (talk about the pattern by design)

Exit code: 0 if clean, 1 if any leak found (prints findings).
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# `\[\[(feedback|project|reference|user)[_-][a-z0-9_-]+\]\]`
# - leading `\[\[` to require the memory-link shape (not arbitrary `[x]`)
# - one of the four category prefixes (the agent memory types)
# - 分隔符是 `[_-]`,**两种都收** —— 见下
# - closing `\]\]`
#
# 🔴 2026-08-18:分隔符原来只写了 `_`,于是**连字符形式整类漏过**:
#
#     [[feedback_kebab_probe_underscore]]   → 拦住   rc=1
#     [[feedback-kebab-probe-hyphen]]       → **放行** rc=0
#
#   (用真脚本实测的,不是读正则读出来的。)
#
#   而这不是一个边缘写法 —— **记忆条目自己的 `name:` 字段用的就是连字符形式**
#   (`name: feedback-a-bug-plus-a-lucky-fact-looks-exactly-like-correct`)。
#   也就是说:**最自然的引用方式(把 name: 的值抄进 [[ ]])恰好是这道门看不见的那一种。**
#   一道隐私门,漏的正是最可能出现的写法。
SLUG_RE = re.compile(r"\[\[(feedback|project|reference|user)[_-][a-z0-9_-]+(?:\.md)?\]\]")

# 🔴 同一个泄漏，换一种写法就绕过了上面那条。2026-08-16 实测:本仓有四处
#    指向私有 memory 库的引用，**一处都没被上面那条命中** —— 因为它们不是
#    `[[slug]]`，而是 markdown 链接和反引号路径:
#      docs/research/…:183   [`feedback_…`](../../agent-orchestra/memory/feedback_….md)
#      docs/rfcs/RFC-029…:9  [RFC-006 (project memory)](../../.claude/memory/)
#      docs/sop/methodology.md:555      `~/.claude/projects/-home-…/memory/`
#      docs/team-collab-playbook.md:368 `/home/<user>/.claude/projects/…/memory/MEMORY.md`
#    前三处在 ALLOWLIST 树里(那是有意的历史豁免)，**第四处不在** ——
#    它带着完整绝对路径和用户名，躺在一个本该被这道门守着的文件里，而门是绿的。
#
#    教训:一条按**形状**写的判据，只挡得住那个形状。同一件事换个语法就穿过去，
#    而且穿过去的时候门还是绿的 —— 绿在这里的含义是"没有那个形状"，
#    不是"没有那件事"。
#
#    这条只认**memory 库路径**这一种形态，故意不去认"任何绝对家目录"：
#    后者全仓 114 处，绝大多数是正当的(测试夹具 /home/tester、
#    agent-network/scripts 里记录的真实部署路径)。一道在正当写法上常红的门，
#    只会教会所有人忽略它的输出 —— 那笔账在 oss-readiness-report 里另记。
MEMORY_PATH_RE = re.compile(
    r"(?:~|/home/[^/\s]+|/Users/[^/\s]+)?/?\.claude/(?:projects/[^/\s`)]+/)?memory/"
    r"|agent-orchestra/memory/"
)

# .sh / .py 同样是公开仓里可见的文件,此前不在覆盖内 —— 实测 2026-08-13,
# 三处真 slug 就藏在 tests/ 下的 shell 脚本里,门扫 898 个文件却看不见它们。
EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".yml", ".yaml", ".sh", ".py"}

# Walk-relative dir names to prune entirely.
SKIP_DIRS = {
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".git",
    ".next",
    ".turbo",
    ".cache",
    # Memory stores by convention.
    "memory",
    ".claude",
}

# Files where the pattern is allowed (this guard talks about it by design).
SELF_ALLOWLIST = {
    ".github/scripts/check-no-memory-slugs.py",
    ".github/workflows/no-memory-slugs.yml",
}

# Path-prefix allowlist for the initial rollout. The pre-existing 57
# legacy references in these trees are historical design context — many
# RFCs intentionally cite the slug as the source of a decision and the
# SOP doc lists agent-memory categories by name. Cleaning them up is
# tracked as a backlog item separate from this guard, so we narrow the
# initial enforcement to production code + user-facing docs and let the
# documentation trees be audited offline at the owners' pace.
#
# REMOVE entries from this list as their backing tree is audited.
ALLOWLIST_PATH_PREFIXES = (
    "docs/sop/",
    "docs/rfcs/",
    "docs/research/",
    "docs/troubleshooting/",
    "docs/tests/",
)


# 🔴 这道门的 FAIL 输出会**原样打印命中的那一段**，而 GitHub Actions 的日志
#    在公开仓里是**公开的**。命中的路径里带着机器用户名(`/home/<user>/…`)——
#    也就是说，一道防泄漏的门，会在报告泄漏的同时把它印进一个公开日志。
#    脱敏放在**入 findings 之前**，不是打印前:只要原值进过列表，
#    后面任何一处打印都可能漏掉那层处理。
#    ⚠️ 第一版只脱了 `/home/<user>/` 这一种写法，跑出来是
#       `/home/<user>/.claude/projects/-home-vansin-agent-orchestra/memory/`
#       —— **同一个用户名在同一个串里出现了两次**，Claude 的 project 目录名
#       就是把家目录路径用连字符编码了一遍。脱掉看得见的那处，剩下的那处
#       长得不像路径，就被漏掉了。
#       **脱一半和没脱，在"用户名有没有进公开日志"这件事上是同一个结果。**
_HOME_RE = re.compile(r"(?<![A-Za-z0-9])(home|Users)([/-])[^/\s-]+")


def redact(snippet: str) -> str:
    """把家目录用户名换掉。两种写法都要:路径形 `/home/x/`，和 Claude
    project 目录名里连字符编码的那份 `-home-x-agent-…`。"""
    return _HOME_RE.sub(r"\1\2<user>", snippet)


def scan(root: Path) -> list[tuple[str, int, str]]:
    findings: list[tuple[str, int, str]] = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # Mutate dirnames in-place so os.walk doesn't descend into pruned dirs.
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fname in filenames:
            path = Path(dirpath) / fname
            if path.suffix.lower() not in EXTENSIONS:
                continue
            rel = path.relative_to(root).as_posix()
            if rel in SELF_ALLOWLIST:
                continue
            if any(rel.startswith(prefix) for prefix in ALLOWLIST_PATH_PREFIXES):
                continue
            try:
                # `errors='replace'` so a stray binary masquerading as a text
                # extension does not abort the whole scan.
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            scanned += 1
            for lineno, line in enumerate(text.splitlines(), start=1):
                for regex in (SLUG_RE, MEMORY_PATH_RE):
                    for match in regex.finditer(line):
                        findings.append((rel, lineno, redact(match.group(0))))
    return findings, scanned


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    if not root.exists():
        print(f"error: scan root does not exist: {root}", file=sys.stderr)
        return 2
    findings, scanned = scan(root)
    # 🔴 报分母。"0 处违规" 只有在 "读了 N 个文件" 旁边才有意义:
    #    扫了 0 个文件与扫了几千个干净文件,原本打印的是**逐字相同**的一行 OK。
    #    实测(2026-08-13):对一个空目录跑本脚本 → rc=0 + "OK: no internal
    #    memory-slug references found",与真正的干净通过无法区分。
    print(f"scanned {scanned} file(s) under {root}")
    if scanned == 0:
        # 这道门守的是"内部 memory slug 不得泄漏进公开仓"这条红线。
        # 零覆盖的守卫与坏掉的守卫无法区分,所以零覆盖必须是失败。
        print(
            "FAIL: scanned 0 files — the scan scope is empty. "
            "Either the root is wrong or the include/exclude rules now match nothing; "
            "a zero-scope guard cannot be distinguished from a broken one.",
            file=sys.stderr,
        )
        return 3
    if not findings:
        print("OK: no internal memory-slug references found")
        return 0
    print(
        f"FAIL: found {len(findings)} internal memory-slug reference(s). "
        "These are private agent-memory pointers and must not leak into "
        "public OSS files — rewrite the comment to convey the intent "
        "directly without the [[slug]] form or a path into the memory store.",
        file=sys.stderr,
    )
    for rel, lineno, snippet in findings:
        print(f"  {rel}:{lineno}: {snippet}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
