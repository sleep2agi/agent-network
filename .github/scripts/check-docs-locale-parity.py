#!/usr/bin/env python3
"""docs-site 的中英页面必须一一对应 —— 只许对称，不许一边多出来。

⚠️ 仓里关于 docs 已经有好几道门，**判据各不相同，不要弄混**：
   · check-doc-symbol-anchors.py    锚点点名的符号在不在它说的那个文件里
   · check-docs-integrity.py        链接/结构完整性
   · check-docs-site-orphans.py     每页至少有一条入口（侧边栏或入链）
   · scripts/check-doc-version-claims.py  上手指南里的版本号对不对
   **本门只判一件事：`docs-site/docs/<p>.md` 与 `docs-site/docs/en/<p>.md` 成不成对。**

## 为什么需要它

新增一页文档时，中文那份几乎总会先写，英文那份靠人记得补。
**漏补不会红** —— 站点照样构建、链接照样通、所有既有的 docs 门都绿，
只是英文读者少一页。这类漂移在本仓目前**没有任何东西会拦**
（2026-08-31 实测：`.github/scripts` + `scripts` 共 32 道 check-* 门，
提到 `en/` 的 5 道逐个读过，判的都是别的事）。

## 判据

一条：`docs-site/docs` 下的 `.md`，去掉 `en/` 前缀后，中英两侧的**集合必须相等**。

## 取集里刻意排除的

`docs-site/docs/public/**` —— 那底下是**静态载荷**（skillhub 的 `SKILL.md` 等），
按设计只有一份，不是本地化页面。2026-08-31 实测：排除它之后中英各 54 页、
差集为空；不排除的话会出现 7 个假阳（全部来自 `public/skillhub/skills/`）。

    python3 .github/scripts/check-docs-locale-parity.py
    python3 .github/scripts/check-docs-locale-parity.py --selftest
"""

from __future__ import annotations

import sys
from pathlib import Path

DOCS = Path("docs-site/docs")
EN = "en"
# 静态载荷,不是本地化页面。见上面的实测。
EXCLUDE_TOP = {"public"}


def collect(root: Path) -> tuple[set[str], set[str], int]:
    """→ (中文相对路径集合, 英文相对路径集合, 扫到的 .md 总数)"""
    zh: set[str] = set()
    en: set[str] = set()
    total = 0
    if not root.is_dir():
        return zh, en, total
    # 🔴 rglob，不是 glob：文档是多级目录（guide/ deploy/ troubleshooting/ …），
    #    非递归只能看见顶层那几页，而分母会跟着一起变小 —— 打印出来和真绿一样。
    for p in sorted(root.rglob("*.md")):
        rel = p.relative_to(root).as_posix()
        parts = rel.split("/")
        if parts[0] == EN:
            if len(parts) > 1 and parts[1] in EXCLUDE_TOP:
                continue
            total += 1
            en.add("/".join(parts[1:]))
        else:
            if parts[0] in EXCLUDE_TOP:
                continue
            total += 1
            zh.add(rel)
    return zh, en, total


def run() -> int:
    zh, en, total = collect(DOCS)
    if total == 0:
        print(f"::error::no .md found under {DOCS} — scope regression, refusing to pass",
              file=sys.stderr)
        return 2
    print(f"scanned {total} localized page(s): zh={len(zh)} en={len(en)} "
          f"(excluding {'/'.join(sorted(EXCLUDE_TOP))}/ static payloads)")
    only_zh = sorted(zh - en)
    only_en = sorted(en - zh)
    if not only_zh and not only_en:
        print("docs locales are in parity; every page exists on both sides.")
        return 0
    for p in only_zh:
        print(f"::error::docs-site/docs/{p} has no English counterpart. "
              f"Add docs-site/docs/en/{p} (or, if it is a static payload rather than a "
              f"localized page, put it under docs-site/docs/public/ and say why in the PR).")
    for p in only_en:
        print(f"::error::docs-site/docs/en/{p} has no Chinese counterpart. "
              f"Add docs-site/docs/{p}.")
    print(f"\n{len(only_zh) + len(only_en)} problem(s).")
    return 1


# --- selftest ---------------------------------------------------------------
# 🔴 两层分开自检：**判据**（给它两个集合，看它报不报）和**取集**（造一棵目录树，
#    看「该收的收进来了没有、该排除的排掉了没有」）。同仓实测过：把 rglob 退回
#    glob，取集自检红而判据自检全绿 —— 两层测的不是同一件事。
def selftest() -> int:
    import tempfile, os
    ok = fail = 0

    def ck(name: str, cond: bool) -> None:
        nonlocal ok, fail
        if cond:
            ok += 1
        else:
            fail += 1
            print(f"  selftest FAIL: {name}")

    with tempfile.TemporaryDirectory() as td:
        cwd = os.getcwd()
        try:
            os.chdir(td)
            def mk(rel: str) -> None:
                p = Path("docs-site/docs") / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("x\n", encoding="utf-8")

            # ── 取集层 ──
            mk("guide/cli.md")                 # 顶层下一级
            mk("en/guide/cli.md")
            mk("a/b/c/deep.md")                # 🔴 深层目录：glob 看不见，rglob 看得见
            mk("en/a/b/c/deep.md")
            mk("public/skillhub/skills/x/1.0.0/SKILL.md")   # 静态载荷，应排除
            mk("guide/notes.txt")              # 非 .md，天然不收
            zh, en, total = collect(Path("docs-site/docs"))
            ck("取集：收了一级目录页", "guide/cli.md" in zh and "guide/cli.md" in en)
            ck("取集：收了深层目录页（rglob 而非 glob）", "a/b/c/deep.md" in zh)
            ck("取集：排除 public/ 静态载荷",
               not any("skillhub" in p for p in zh | en))
            ck("取集：分母 = 4（两对页面，不含 public 与 .txt）", total == 4)

            # ── 判据层 ──
            ck("判据：对称时 rc=0", run() == 0)
            mk("guide/only-zh.md")             # 只有中文
            ck("判据：中文多一页 → rc=1", run() == 1)
            mk("en/guide/only-zh.md")
            ck("判据：补上英文后回到 rc=0", run() == 0)
            mk("en/guide/only-en.md")          # 只有英文
            ck("判据：英文多一页 → rc=1", run() == 1)
        finally:
            os.chdir(cwd)

    # 空目录必须失败关闭（0 页和「全对称」打印出来不一样，但退出码不能一样）
    with tempfile.TemporaryDirectory() as td:
        cwd = os.getcwd()
        try:
            os.chdir(td)
            ck("空目录 → rc=2（分母承重，不当成全对称）", run() == 2)
        finally:
            os.chdir(cwd)

    print(f"selftest: {ok}/{ok + fail} ok")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(run())
