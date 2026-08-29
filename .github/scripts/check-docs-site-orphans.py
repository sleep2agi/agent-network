#!/usr/bin/env python3
"""站点上新增的页面,得有人能走到它。

## 为什么是**棘轮**,而且只钉 docs-site

量过再定的范围(2026-08-30,`origin/main`):

    docs/**/*.md                 226 个,其中 97 个(43%)零入链
    docs-site/docs/**/*.md       110 个,其中「无侧边栏入口 **且** 无入链」= 0 个

🔴 `docs/**` **刻意不在范围内**。那 97 个里占大头的是 `analysis/`、`archive/`、
`research/`、`design/side-thread-pr*`、`release/*/RELEASE-NOTES.md` ——
**证据与归档产物没有入链是正常状态,不是缺陷**,它们靠 grep 和 issue 引用找到。
对它们判红 = 一道 43% 是误报的门,而一道会误拦的门最坏的后果不是拦错一次,
是**它教会人绕过门**。

而 docs-site 是**发布出去的页面**:可达性只有两条路 —— 在侧边栏,或被别的页面链到。
两条都没有 = 读者能搜到、却走不回来。

## 🔴 基线为 0,所以这里没有豁免名单

当前真不可达页 = 0(上面量的)。**空基线的棘轮是最好的那种**:
不需要维护存量清单、不会有"这是历史遗留"这条退路,而存量清单会过期、会烂、
最后变成没人读的墙纸。

(澄清一个容易混的口径:#1226 数出的 13 个是「**无侧边栏入口**」——
它们大多仍从 hub 页链得到,比如 `troubleshooting/*` 由 `troubleshooting.md` 聚合。
那 13 个**不是**孤儿。两个数不是一回事。)

## 判据

对每个 `docs-site/docs/**/*.md`(排除 `public/**` —— 那是静态资源,不是页面):

    可达 = 在 .vitepress/config.ts 里有 link 指向它
         或 被任意另一个 .md 链到

两者皆无 ⇒ 红,并列出该页 + 两条修法。

🔴 **必须两条都认。** 只认侧边栏的话,`troubleshooting/*` 那一整个目录会全红 ——
而它们是**有意**不进侧边栏、靠 hub 页聚合的。少了这一条,门上线第一天就误伤一个目录。

## 这道门不保证什么

- 完全不看 `docs/**`(见上)。
- 只判「有没有人指向这一页」,**不判那个链接显不显眼** —— 藏在页脚第 9 条也算可达。
- 不判页面内容是否还有价值。

    python3 .github/scripts/check-docs-site-orphans.py
    python3 .github/scripts/check-docs-site-orphans.py --selftest
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

DOCS = Path("docs-site/docs")
CONFIG = DOCS / ".vitepress/config.ts"
NAV_LINK = re.compile(r"link:\s*'([^']+)'")
MD_LINK = re.compile(r"\]\(([^)\s]+)\)")


def page_slug(rel: str) -> str:
    """`guide/x.md` → `guide/x`;`guide/index.md` → `guide`(目录首页)。"""
    slug = rel[: -len(".md")]
    if slug.endswith("/index"):
        slug = slug[: -len("/index")]
    return slug


def nav_slugs(config_text: str) -> set[str]:
    return {l.strip("/").rstrip("/") for l in NAV_LINK.findall(config_text)}


def is_reachable(slug: str, rel: str, nav: set[str], corpus: str) -> bool:
    """侧边栏有入口,或被别的页面链到 —— 两条任一即可达。"""
    if slug in nav or slug == "index" or slug == "":
        return True
    # 站点内绝对路径写法:](/guide/x) 或 ](/guide/x#anchor)
    if f"](/{slug}" in corpus:
        return True
    # 相对写法:](x.md) / ](../guide/x.md)
    base = rel.rsplit("/", 1)[-1]
    if f"]({base}" in corpus or f"/{base}" in corpus:
        return True
    return False


def collect(root: Path) -> list[str]:
    """取集单独成函数 —— 门的盲区通常在「怎么拿到要判的东西」,不在判据。

    🔴 本文件自己就是一个标本:第一版 selftest **8/8 全绿**,而门在真仓上
    报了 3 个假阳性 —— 因为 selftest 直接喂 corpus,**绕过了取语料这一层**。
    判据和取集是两层,绿的时候它们长得一模一样。
    ⇒ 所以必须**同时**跑 `--selftest` 和真仓,两者都不能省。
    """
    out = subprocess.run(
        ["git", "ls-files", "docs-site/docs"], capture_output=True, text=True
    ).stdout
    rels = []
    for line in out.split("\n"):
        line = line.strip()
        if not line.endswith(".md"):
            continue
        rel = line[len("docs-site/docs/"):]
        if rel.startswith("public/"):      # 静态资源根,不是页面
            continue
        rels.append(rel)
    return rels


def run() -> int:
    if not DOCS.is_dir() or not CONFIG.is_file():
        print("::error::取集塌了:找不到 docs-site/docs 或 .vitepress/config.ts —— 拒绝通过",
              file=sys.stderr)
        return 2
    pages = collect(DOCS)
    if not pages:
        # 扫到 0 个页面和 0 个孤儿,打印出来是同一片绿。
        print("::error::扫到 0 个站点页面 —— 分母塌了,拒绝通过", file=sys.stderr)
        return 2

    nav = nav_slugs(CONFIG.read_text(encoding="utf-8"))
    # 🔴 pathspec 用目录,不用 `docs-site/docs/**/*.md`。
    #    那个 glob **排除顶层文件** —— 而 hub 页(troubleshooting.md / index.md)恰恰在顶层,
    #    链接就写在它们里面。用它取语料,会把「被 hub 页链到」的页面全判成孤儿。
    #    实测:该 glob 语料 1,096,813 字节且**不含** `](/troubleshooting/node-stuck-lifecycle`;
    #         换成目录后 1,313,289 字节,含。3 个假阳性就是这么来的。
    #    ⇒ 判据当时是对的,盲区在**怎么取语料**。
    corpus = subprocess.run(
        ["git", "grep", "-h", "", "--", "docs-site/docs"],
        capture_output=True, text=True,
    ).stdout

    orphans = []
    for rel in pages:
        if not is_reachable(page_slug(rel), rel, nav, corpus):
            orphans.append(rel)

    print(f"扫了 {len(pages)} 个站点页面;侧边栏条目 {len(nav)} 条;不可达 {len(orphans)} 个")
    if orphans:
        for rel in orphans:
            print(f"::error file=docs-site/docs/{rel}::这一页没有任何入口 —— "
                  f"侧边栏里没有它,也没有别的页面链到它。读者能搜到它、却走不回来。"
                  f"两条修法任选:①挂进 docs-site/docs/.vitepress/config.ts 的侧边栏;"
                  f"②从相关的 hub 页(如 troubleshooting.md)链过去。")
        print(f"\n{len(orphans)} 个新孤儿页。")
        print("🔴 这道门的基线是 0 —— 没有豁免名单,也不打算有:"
              "存量清单会过期、会烂,最后变成没人读的墙纸。")
        return 1
    print("每一页都至少有一条入口(侧边栏或入链)。")
    return 0


def selftest() -> int:
    cases = []

    def check(name, ok, detail=""):
        cases.append((name, ok, detail))

    check("slug: 普通页", page_slug("guide/x.md") == "guide/x")
    check("slug: 目录首页", page_slug("guide/index.md") == "guide")
    check("nav 解析", nav_slugs("link: '/guide/x'") == {"guide/x"})

    NAV = {"guide/x"}
    # ① 在侧边栏 → 可达
    check("① 侧边栏里有 → 可达",
          is_reachable("guide/x", "guide/x.md", NAV, "") is True)
    # ② 🔴 只被 hub 页链到、不在侧边栏 → 也必须可达
    #    少了这条,troubleshooting/* 那一整个目录会被误红。
    check("② 只从 hub 页链到(不在侧边栏)→ 也可达",
          is_reachable("troubleshooting/y", "troubleshooting/y.md", NAV,
                       "- [某标题](/troubleshooting/y) 说明") is True)
    check("②b 相对写法链到 → 也可达",
          is_reachable("troubleshooting/y", "troubleshooting/y.md", NAV,
                       "见 [某标题](y.md)") is True)
    # ③ 两条都没有 → 孤儿
    check("③ 侧边栏没有、也没人链 → 不可达",
          is_reachable("guide/lonely", "guide/lonely.md", NAV,
                       "完全无关的正文") is False)
    # ④ 正控放在反侧:别让「任意子串命中」冒充入链
    check("④ 只是名字相似、并非链接 → 仍不可达",
          is_reachable("guide/lonely", "guide/lonely.md", NAV,
                       "这段提到 guide/lonely 但没有链接语法") is False)

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   [{detail}]" if detail and not ok else ""))
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else run())
