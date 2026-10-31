#!/usr/bin/env python3
"""兼容字段 `license` 的**生产不可达护栏**。

2026-10-31 —— 起因（外部复核，原话）：
    「`sla_hours` 加生产不可达护栏：任何 `stats.summarize(..., sla_hours=...)` 都会红。」
    ⇒ 一个参数只要还能被生产代码传进来，那个旁路就一直在。

本仓的同类是 `/health` 的兼容字段 `license`：
    license: license?.type || "none"     ← 两种「没有」压成同一个字符串（语义不精确）
    判据请用 license_state（known / absent / unknown）
本仓当前**没有任何消费者**读 `.license` —— 这条护栏要保证它保持为零。

护栏口径：在 server/src / agent-node/src / agent-network/src（不含 *.test.ts）里，
除渲染点与赋值点之外，出现 `.license` 属性读取即红。

用法：python3 scripts/check-legacy-license-usage.py [--json]
退出码：0 = 没有旁路读取；1 = 有；2 = 拿不到读数（扫描域为空）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOTS = ["server/src", "agent-node/src", "agent-network/src"]
# 2026-10-31 —— 外部复核 (c)：「护栏不能弄红就等于没有」——每种绕过形状都要有 must-fire。
# 覆盖三种写法（第一版只有第一种，另外两种是真绕过）：
#   ① 点访问      body.license / body?.license
#   ② 下标访问    body["license"] / body['license']
#   ③ 解构        const { license } = body / { license, ...rest } = body
READ = re.compile(r"""
    \.license\b(?!_)
  | \[\s*["']license["']\s*\]
  | \{\s*license\s*[,}]
""", re.X)
ALLOW = {
    # 渲染点：把行渲染成兼容字符串（逐字保持旧行为，便于逐步下线）
    "server/src/license-state.ts": "legacyLicenseField 的渲染实现（兼容字段的唯一生产者）",
}
# 2026-10-31 —— 文件名级豁免太粗：`server/src/server.ts` 一旦整文件豁免，
# 在任何一行读 `.license` 做判断都不会红（witnessed 实测：注入旁路读取仍绿）。
# ⇒ 改成**行级**豁免：只放行赋值点那一行。
ALLOW_LINE = re.compile(r"^\s*license:\s*legacyLicenseField\(")


def tracked() -> list[Path]:
    out = subprocess.run(["git", "ls-files", *[f"{r}/*.ts" for r in ROOTS]],
                         cwd=REPO, capture_output=True, text=True, timeout=60).stdout
    return [REPO / l for l in out.split("\n") if l.strip() and not l.endswith(".test.ts")]


def scan() -> tuple[list[dict], int]:
    hits, files = [], 0
    for p in tracked():
        if not p.exists():
            continue
        files += 1
        rel = str(p.relative_to(REPO))
        if rel in ALLOW:
            continue
        for i, ln in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if ln.lstrip().startswith("//") or ln.lstrip().startswith("*"):
                continue
            if READ.search(ln) and not ALLOW_LINE.search(ln):
                hits.append({"file": rel, "line": i, "text": ln.strip()[:120]})
    return hits, files


def selftest(quiet: bool = False) -> int:
    """一个必须命中的坏样本 + 一个必须放行的好样本。"""
    bad = 'const t = body.license ?? "none";'
    good = "const t = body.license_state;"
    cases = [
        (bad, True),
        (good, False),
        # 下标访问：第一版正则漏掉它（真绕过）
        ('const t = body["license"];', True),
        ("const t = body['license'] ?? 'none';", True),
        # 解构：同样绕过
        ("const { license } = body;", True),
        ("const { license, status } = body;", True),
        # 可选链（点访问的变体，必须同样命中）
        ("const t = body?.license;", True),
    ]
    _ = (bad, good)
    out = []
    for src, want in cases:
        got = bool(READ.search(src))
        if got != want:
            out.append(f"{src!r}: 期望 hit={want}，实际 {got}")
        elif not quiet:
            print(f"✓ selftest {'命中' if want else '不命中'}: {src}")
    if out:
        print("✗ 自检失败：", file=sys.stderr)
        for o in out:
            print(f"    · {o}", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {len(cases)} 例符合预期（3 种写法：点/下标/解构，各含正反例）")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        # shell 的 $? 只反映进程退出码；上面那次 witness 里 head 吞掉了它 ⇒ 这里显式返回。
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    hits, files = scan()
    if files == 0:
        print("扫描域为空：一个源文件都没扫到 ⇒ 没有读数", file=sys.stderr)
        return 2
    if "--json" in sys.argv:
        print(json.dumps({"object": ROOTS, "files": files, "bypass_reads": hits,
                          "allow": ALLOW}, ensure_ascii=False, indent=2))
        return 1 if hits else 0
    print(f"对象：{files} 个源文件（不含 *.test.ts）；读取 `.license` 的旁路点：{len(hits)}")
    if hits:
        print("✗ 有代码在读兼容字段 `license` —— 它区分不了「没有授权」与「没查到」：", file=sys.stderr)
        for h in hits[:20]:
            print(f"    · {h['file']}:{h['line']}  {h['text']}", file=sys.stderr)
        print("  ⇒ 判据请用 license_state（known / absent / unknown）；若确有渲染需求，登记进 ALLOW 并说明。",
              file=sys.stderr)
        return 1
    print("✓ 没有旁路读取：兼容字段只在渲染点与赋值点出现")
    print("  check : 重跑本脚本；新增 `.license` 读取 ⇒ 红。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
