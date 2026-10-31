#!/usr/bin/env python3
"""「去跑 X」之前，先证 X 存在 —— 一条关于**指令**的静态门。

2026-10-31 —— 起因（外部复核，原话）：
    我让人去跑一个从没实现过的仪器：`?probe=1` 在 bundle 里 0 处。
    ⇒ 这类错误的产出不是错误读数，是**合理读数**：
       未知 query 被忽略 ⇒ 正常返回 ⇒ 「跑完了，没反应」
       ⇒ 与「判别器说没有」同形。

    规则：任何「去跑 X」的请求，X 的存在性必须在请求之前被证一次。

本脚本把这条规则机械化到我们能查的那一半：仓库里任何 `scripts/<x>.py|.sh|.mjs` 的**文字引用**
（文档、注释、错误消息、workflow）都必须能解析到一个真实文件。

解析口径（按**引用者所在目录**向上找最近的 scripts/）：
    agent-network/src/x.ts 里写 scripts/<name>.mjs ⇒ 就近指 agent-network/scripts/<name>.mjs
    docs/ 里写 scripts/<name>.sh          ⇒ 指仓库根 scripts/<name>.sh
⇒ 不做就近解析会产生大量假阳（实测 35 条里 30 条是这个原因）

用法：python3 scripts/check-script-references.py [--json]
退出码：0 = 全部可解析；1 = 有悬空引用。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCAN_EXT = ("*.py", "*.sh", "*.ts", "*.mjs", "*.md", "*.yml")
REF = re.compile(r"(?<![\w./-])scripts/([A-Za-z0-9._-]+\.(?:py|sh|mjs))")

# 已知悬空：必须带理由与**移出条件**（否则它会按期续命，见今晚那条）。
ALLOWLIST = {
    ("docs-site/docs/guide/dsh.md", "connect.mjs"):
        ("文档指向 dsh 插件的辅助脚本；本仓没有这个文件，也没有证据说它属于本仓",
         "确认该脚本所在仓并把路径改对（或删掉这一节）"),
    ("docs-site/docs/en/guide/dsh.md", "connect.mjs"):
        ("同上（英文版）", "同上"),
    ("docs/pre-pr-selfcheck.md", "check-xxx.py"):
        ("文档里的占位符，示例写法", "若有人把它当真：改成真实脚本名或标注「示例」"),
}


def tracked() -> list[Path]:
    out = subprocess.run(["git", "-C", str(REPO), "ls-files", *SCAN_EXT],
                         capture_output=True, text=True).stdout.split()
    return [REPO / p for p in out]


def resolves_from(citing: Path, name: str) -> bool:
    """从引用者所在目录向上找最近的 scripts/，任何一个命中即算存在。"""
    for anc in citing.parents:
        if (anc / "scripts" / name).exists():
            return True
    return False


SELFTEST_EXPECTED = 3


def selftest(quiet: bool = False) -> int:
    """三例：就近解析命中 / 悬空引用被抓 / REF 正则能抓到三种写法。

    为什么这一段必须有自检：这条门的判据是「引用能解析」，而**解析口径本身改过一次**
    （从「仓库根」改成「按引用者目录就近」）—— 口径变了而没有自检，
    门的绿就只是「没人再改它」。
    """
    import tempfile
    fails = 0
    ran = 0
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "scripts").mkdir()
        (root / "scripts" / "exists.sh").write_text("#!/bin/sh\n")
        (root / "sub" / "scripts").mkdir(parents=True)
        (root / "sub" / "scripts" / "near.sh").write_text("#!/bin/sh\n")
        citing = root / "sub" / "doc.md"
        # 名字**拼出来**而不是写成字面量：本门会扫自己的源码，
        # 字面量 `scripts/near.sh` 会被它自己当成悬空引用（第一版就是这样被自己抓到的）。
        S = "scripts/"
        citing.write_text("run " + S + "near.sh")

        ran += 1
        ok = resolves_from(citing, "nea" + "r.sh")
        if not ok: fails.append("就近解析应命中 sub/scripts/near.sh")
        elif not quiet: print("✓ selftest 就近解析命中")

        ran += 1
        ok = not resolves_from(citing, "nop" + "e.sh")
        if not ok: fails.append("不存在的引用不应解析成功")
        elif not quiet: print("✓ selftest 悬空引用解析失败（会被报出来）")

        ran += 1
        found = set(REF.findall("a " + S + "x.py b " + S + "y.sh c " + S + "z.mjs"))
        ok = found == {"x.py", "y.sh", "z.mjs"}
        if not ok: fails.append(f"REF 正则漏写法：{sorted(found)}")
        elif not quiet: print("✓ selftest REF 抓到 .py/.sh/.mjs 三种写法")

    if ran != SELFTEST_EXPECTED:
        print(f"✗ 自检用例数应为 {SELFTEST_EXPECTED}，实际 {ran}", file=sys.stderr)
        return 1
    if fails:
        print("✗ 自检失败：", file=sys.stderr)
        for f in fails: print(f"    · {f}", file=sys.stderr)
        return 1
    if not quiet: print(f"✓ selftest {ran}/{ran} 通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    dangling: list[tuple[str, str]] = []
    checked = 0
    for path in tracked():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = str(path.relative_to(REPO))
        for name in set(REF.findall(text)):
            checked += 1
            if not resolves_from(path, name) and (rel, name) not in ALLOWLIST:
                dangling.append((rel, name))

    if "--json" in sys.argv:
        print(json.dumps({"refs_checked": checked, "dangling": dangling}, ensure_ascii=False, indent=1))
        return 0 if not dangling else 1

    print(f"检查 {checked} 处 `scripts/…` 文字引用（按引用者目录就近解析）")
    for (f, name), (why, exit_when) in sorted(ALLOWLIST.items()):
        print(f"  · 已知悬空（豁免）：{f} → scripts/{name}")
        print(f"      理由：{why}")
        print(f"      移出条件：{exit_when}")
    if not dangling:
        print("✓ 全部可解析：没有「让人去跑一个不存在的脚本」")
        return 0
    print(f"✗ {len(dangling)} 处悬空引用：", file=sys.stderr)
    for f, name in sorted(set(dangling))[:20]:
        print(f"    {f} → scripts/{name}", file=sys.stderr)
    print("  ⇒ 这些指令指向一个不存在的文件；按今晚那条规则，它会让下一个人「跑了，没反应」并当成结论。",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
