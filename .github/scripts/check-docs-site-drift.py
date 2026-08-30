#!/usr/bin/env python3
"""anet.sh 上的文档,是不是 main 上的那一份。

## 为什么需要它

`docs-site` 那个 Vercel 项目**没有接 git 自动部署**(见 `deploy/docs-site/README.md`)。
合并进 `main` **不会**让站点更新 —— 必须有人手动跑 `vercel --prod`。

**这条链路的失败方式是「静默分叉」**:不报错、不告警,站点照常返回 200,
只是内容停在某次部署。仓里记录过停 36 小时、以及冻结近 14 天。

## 🔴 判据用「内容」,不用 `age:` 头

`deploy/docs-site/README.md` 曾建议用 `curl -sI | grep '^age:'` 自检
(「age 很大 = 很久没部署」)。**实测这个信号不成立** —— 同一时刻:

    /                    age: 442813   （5.13 天)
    /deploy/npm          age: 212508   （2.46 天)
    /concepts/security   age:    285   （4.75 分钟)

`age` 是 **CDN 上这个对象的缓存年龄**,不是部署年龄;**任何人**最近访问过某页
都会把它清零。

⇒ **它的偏差方向是「让很旧的站点看起来很新」——用它自检,漏报是默认结果。**

## 判据

对每个采样页面:取 main 上对应 markdown 里的一句**指纹**(足够长、足够独特),
抓线上那一页,断言指纹出现。缺一条 = 站点落后于 main。

指纹从**最近改动过**的文档里选 —— 那正是最可能没上线的部分。

## 失败方向

- 网络/站点不可达 → **exit 2**(说不清楚就不说"没问题")
- 一个采样页面都取不到 → **exit 2**(取集塌了)
- 指纹缺失 → exit 1,并打印缺哪一条、对应哪个文件

    python3 .github/scripts/check-docs-site-drift.py
    python3 .github/scripts/check-docs-site-drift.py --selftest
"""

from __future__ import annotations

import json
import re
from html import unescape as html_unescape
import subprocess
import sys
import html as _html
import urllib.error
import urllib.request
from pathlib import Path

SITE = "https://anet.sh"
DOCS = Path("docs-site/docs")
SAMPLE_LIMIT = 6
TIMEOUT = 25


def md_to_url(rel: str) -> str:
    """`docs-site/docs` 下的相对路径 → 站点上的地址。

    🔴 `docs/public/` 是 VitePress 的**静态资源根**:发布时剥掉 `public/`
    这一段,**并且保留原扩展名**(`…/SKILL.md` 就是 `…/SKILL.md`,不是 `…/SKILL`)。
    原来这里对所有路径一律走「去掉末尾 3 个字符」,于是:

        public/skillhub/skills/x/1.0.0/SKILL.md → /public/skillhub/…/SKILL   ← 多了 /public、丢了 .md
        public/skillhub/catalog.json            → /public/skillhub/catalog.j ← 把 "son" 也切掉了

    第二种是无条件的垃圾地址 —— 因为切长度写死成 `len(".md")`,
    对任何非 `.md` 的产物文件都会砍掉三个字符。
    """
    if rel.startswith("public/"):
        return "/" + rel[len("public/"):]
    if rel.endswith(".md"):
        u = "/" + rel[: -len(".md")]
        if u.endswith("/index"):
            u = u[: -len("index")]
        return u or "/"
    return "/" + rel


# 产物类文件:不是 markdown,判据也不是「指纹出现在渲染后的页面里」。
# 🔴 覆盖面缺口:`recent_docs()` 原来只收 `.md`,而 `catalog.json` 不是 `.md`
# ⇒ skillhub 目录漂移(线上 2 条 / main 6 条)**从来不在这道门的判据里**。
ARTIFACT_NAMES = ("catalog.json",)
ARTIFACT_LIMIT = 4


def recent_artifacts(limit: int = ARTIFACT_LIMIT) -> list[str]:
    """最近改动过的**产物类**文件(相对 docs-site/docs)。

    单独给预算,不跟 markdown 抢 `SAMPLE_LIMIT` —— 扩覆盖面不能以缩小另一半为代价。
    """
    out = subprocess.run(
        ["git", "log", "-n", "80", "--name-only", "--pretty=format:", "--", "docs-site/docs"],
        capture_output=True, text=True,
    ).stdout
    seen: list[str] = []
    for line in out.split("\n"):
        line = line.strip()
        if not line.startswith("docs-site/docs/"):
            continue
        rel = line[len("docs-site/docs/"):]
        if Path(rel).name not in ARTIFACT_NAMES or rel in seen:
            continue
        if not (DOCS / rel).exists():
            continue
        seen.append(rel)
        if len(seen) >= limit:
            break
    return seen


def catalog_entries(payload) -> list[str]:
    """catalog.json → 条目名列表(两种可能的外形都收)。"""
    items = payload if isinstance(payload, list) else payload.get("skills", [])
    names = []
    for it in items:
        if isinstance(it, dict):
            names.append(str(it.get("name") or it.get("id") or it))
        else:
            names.append(str(it))
    return sorted(names)


def recent_docs(limit: int) -> list[str]:
    """最近被改动过的 docs-site markdown(相对 docs-site/docs 的路径)。"""
    out = subprocess.run(
        ["git", "log", "-n", "80", "--name-only", "--pretty=format:", "--", "docs-site/docs"],
        capture_output=True, text=True,
    ).stdout
    seen: list[str] = []
    for line in out.split("\n"):
        line = line.strip()
        if not line.endswith(".md") or not line.startswith("docs-site/docs/"):
            continue
        rel = line[len("docs-site/docs/"):]
        if rel in seen:
            continue
        if not (DOCS / rel).exists():          # 已删除的文件不采样
            continue
        seen.append(rel)
        if len(seen) >= limit:
            break
    return seen


def added_lines(rel: str, commits: int = 40) -> list[str]:
    """最近若干次提交里,**这个文件新增的行**(去掉 diff 的 `+` 前缀)。

    🔴 为什么必须只看新增行,而不是文件里任意一行:
    第一版从整份文件里挑指纹,结果 6 个采样页有 5 个报 ok —— 因为挑中的那句
    **在新旧两个版本里都有**,自然线上也能找到。而我明确知道其中至少两页
    缺了今天新加的告示。**它的偏差方向和 `age` 一样:倾向于报"没问题"。**
    只有"main 上有、且是最近才有的"那些行,才能证明站点是不是跟上了。
    """
    out = subprocess.run(
        ["git", "log", "-n", str(commits), "-p", "--pretty=format:", "--", f"docs-site/docs/{rel}"],
        capture_output=True, text=True,
    ).stdout
    added = []
    for line in out.split("\n"):
        if line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
    return added


def fingerprint(text: str) -> str | None:
    """挑一句足够独特、且不含 markdown 结构字符的正文。"""
    # 🔴 剥掉 HTML 注释块再挑指纹。VitePress 渲染时会丢弃 `<!-- ... -->`,
    #    所以注释里的任何一行**永远不会**出现在线上页面上。旧代码只跳过
    #    以 `<` 开头的行(注释首行),漏了多行注释的**续行**(strip 后不以 `<`
    #    开头)——于是把 getting-started 里那段 version-claim 说明的续行当指纹,
    #    对着线上永远找不到 ⇒ 恒 MISS 的假漂移(#1424 的戳改动实测中招)。
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    in_fence = False
    for raw in text.split("\n"):
        line = raw.strip()
        # 🔴 跳过代码围栏**内部**的行。围栏起始行以反引号开头,会被下面那条
        #    startswith 过滤掉;但围栏内部的行不以反引号开头,于是会被选中。
        #    而 VitePress 给代码块做语法高亮,把每个 token 拆进独立 <span> ——
        #    渲染后的 HTML 里不存在这样一段**连续**文本,所以永远匹配不上,
        #    这道门就会报出**假的「落后」**。2026-08-30 #1547 部署后实测到:
        #    门说 1 page behind,而人工核对内容确实已上线,被选中的指纹正是
        #    ```bash 围栏里的 `anet node stop <name> && anet daemon start <name>`。
        #    危险在方向:它把人推去做一次无谓的重新部署。跳过是安全的 ——
        #    一条指纹都挑不出来时 run() 会明确报错拒绝通过,不会静默放行。
        if line.startswith("```") or line.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        # 🔴 按 **UTF-8 字节** 卡长度,不按字符数。这个仓的文档以中文为主,
        # 一句信息量充足的中文常常只有 20-30 个字符 —— 用 `len(line) < 40`
        # 会把几乎所有中文正文都判成"太短"而跳过,最终一条指纹都选不出来。
        # (这是 selftest 第 5 条抓出来的,不是我读出来的:那条夹具的中文正文
        #  30 字符、90 字节,在字符口径下返回 None。)
        # 60 字节 ≈ 20 个中文字 ≈ 60 个英文字符,两种语言都够独特。
        blen = len(line.encode("utf-8"))
        if blen < 60 or blen > 400:
            continue
        if line.startswith(("#", ">", "-", "*", "|", "`", ":::", "<")):
            continue
        if "http" in line or "](" in line:      # 链接在渲染后形态会变
            continue
        # 渲染后 markdown 强调符号会消失,挑不含它们的句子
        if any(c in line for c in "*_`"):
            continue
        return line
    return None


class SiteMissing(Exception):
    """站点对这个地址回了 404 —— 服务器答了话,只是没有这一页。"""


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "anet-docs-drift-check"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        # 🔴 404 与「连不上」不是同一件事,不该给同一个退出码。
        # main 上存在、线上 404 ⇒ 这**正是**这道门要抓的漂移(exit 1),
        # 而不是「说不清楚」(exit 2)。原来两者都走 exit 2,于是真漂移被
        # 报成 `cannot fetch … refusing to pass` —— 读起来像网络抽风,
        # 这正是它连红 8 天没人处理的原因之一:**错的不是判定,是判定被归到了错的层**。
        if exc.code == 404:
            raise SiteMissing(url) from exc
        raise


# 🔴 版本戳是这道门**结构上看不见**的一格，而它恰恰是用户会照着敲的那个数。
#
#   实测（2026-08-30，bump 到 .69 之后）：线上 getting-started 仍显示 `.68`，
#   而这道门报 `every sampled page on the live site matches main` / rc=0。
#   原因不在采样，getting-started **就在被采样的 6 页里**，原因在 `fingerprint()`：
#     · 机器戳 `<!-- version-claim: … version=2.3.0-preview.69 -->` 是 HTML 注释
#       → 在挑指纹之前就被 `re.sub(r"<!--.*?-->", "")` **整段剥掉**；
#     · 人读那份 `| \`2.3.0-preview.69\`(当前 preview) | …` 是表格行
#       → 命中 `line.startswith("|")` **被跳过**。
#   于是它挑中的是同一页里一句与版本无关的正文（实测挑到的是一条 `anet demo` 说明），
#   那句话在新旧两版里都有 ⇒ **恒绿**。
#
#   ⇒ 一个「装 2.3.0-preview.68」的过期指引可以在线上待任意久，而这道门一直是绿的。
#      用户照着敲，装到的是旧版本。所以这一格单独判，不走 fingerprint 那条路。
def version_stamps(rel: str) -> list[str]:
    """这一页 main 上声明的 preview 版本号（机器戳优先，取不到再退回人读表格行）。"""
    try:
        text = (DOCS / rel).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    stamps = re.findall(r"version-claim:[^>]*channel=preview[^>]*version=([0-9][0-9A-Za-z.\-]+)", text)
    return sorted(set(stamps))


def run() -> int:
    if not DOCS.is_dir():
        print(f"::error::{DOCS} not found — scope regression, refusing to pass", file=sys.stderr)
        return 2
    samples = recent_docs(SAMPLE_LIMIT)
    if not samples:
        print("::error::no recently-changed docs found to sample — refusing to pass "
              "on an empty denominator", file=sys.stderr)
        return 2

    checked = 0
    missing: list[tuple[str, str, str]] = []
    for rel in samples:
        # 只从「最近新增的行」里选指纹 —— 见 added_lines 的注释。
        # 拿不到新增行时退回整份文件,但那种情况下这一页只能证明"站点还活着"。
        recent = added_lines(rel)
        # Drop any added line that lives inside an HTML comment in the current
        # file — it never renders, so verifying it against the live page is a
        # guaranteed false MISS (see fingerprint()).
        try:
            _ftext = (DOCS / rel).read_text(encoding="utf-8", errors="replace")
            _clines = set()
            for _blk in re.findall(r"<!--.*?-->", _ftext, flags=re.DOTALL):
                for _cl in _blk.split("\n"):
                    _s = _cl.strip()
                    if _s:
                        _clines.add(_s)
            recent = [l for l in recent if l.strip() not in _clines]
        except OSError:
            pass
        fp = fingerprint("\n".join(recent)) if recent else None
        source = "recent-added"
        if fp is None:
            fp = fingerprint((DOCS / rel).read_text(encoding="utf-8", errors="replace"))
            source = "whole-file(weaker)"
        if fp is None:
            print(f"  skip {rel} — no stable fingerprint sentence found")
            continue
        url = SITE + md_to_url(rel)
        try:
            html = fetch(url)
        except SiteMissing:
            checked += 1
            print(f"  MISS {rel}  →  {md_to_url(rel)}   [404 — 线上没有这一页]")
            missing.append((rel, md_to_url(rel), "整页在线上不存在(404)"))
            continue
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            print(f"::error::cannot fetch {url}: {exc} — refusing to pass", file=sys.stderr)
            return 2
        checked += 1
        # 渲染后会插入标签;比对时把标签去掉再找。
        text = re.sub(r"<[^>]+>", " ", html)
        # 🔴 还要把 HTML 实体解回来:指纹句里的 `"<alias>"` / `"latest"` 在渲染页里是
        # `&quot;&lt;alias&gt;&quot;` —— 不解码时子串永远配不上,这道门就会把
        # 「已经部署好的页」报成 behind main(2026-08-29 两个英文页实测假阳性)。
        text = _html.unescape(text)
        text = re.sub(r"\s+", " ", text)
        # 🔴 渲染会改写指纹里的字符，比对前两边都要过同一次归一化，否则会报假红：
        #   ① VitePress 把 `'` 渲染成 `&#39;`（`"` → `&quot;`，`&` → `&amp;`…），
        #      所以任何**带引号**的源码行（SQL/JSON/命令行里到处都是）永远匹配不上；
        #   ② 语法高亮把 token 拆进各自的 <span>，去标签后会多出空格
        #      （`'system',` → `'system' ,`），所以标点前后也要归一。
        #   实测：`actor TEXT NOT NULL DEFAULT 'system', -- …` 这一行，
        #   **刚构建出来的本地产物**里也匹配不上 —— 也就是说这条红与线上新旧无关，
        #   是判据自身的洞。会让人以为"站点没部署"，然后去重复部署（而那不会有任何效果）。
        text = html_unescape(text)
        text = re.sub(r"\s*([,;:])\s*", r"\1", text)
        fp_norm = re.sub(r"\s+", " ", html_unescape(fp))
        fp_norm = re.sub(r"\s*([,;:])\s*", r"\1", fp_norm)
        stale_stamp = None
        for stamp in version_stamps(rel):
            # 线上那一页必须出现 main 上声明的同一个版本号。
            if stamp not in text:
                stale_stamp = stamp
                break
        if stale_stamp:
            print(f"  MISS {rel}  →  {md_to_url(rel)}   [version-stamp {stale_stamp} 不在线上]")
            missing.append((rel, md_to_url(rel), f"版本戳 {stale_stamp}（main 上声明的 preview 版本）在线上这一页里找不到"))
        elif fp_norm in text:
            print(f"  ok   {rel}  →  {md_to_url(rel)}   [{source}]")
        else:
            print(f"  MISS {rel}  →  {md_to_url(rel)}   [{source}]")
            missing.append((rel, md_to_url(rel), fp))

    # --- 产物类文件:判据是「条目集合」,不是「指纹出现在渲染页里」 ---
    for rel in recent_artifacts():
        url = SITE + md_to_url(rel)
        try:
            raw = fetch(url)
        except SiteMissing:
            checked += 1
            print(f"  MISS {rel}  →  {md_to_url(rel)}   [404 — 产物在线上不存在]")
            missing.append((rel, md_to_url(rel), "产物在线上不存在(404)"))
            continue
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            print(f"::error::cannot fetch {url}: {exc} — refusing to pass", file=sys.stderr)
            return 2
        checked += 1
        try:
            live = catalog_entries(json.loads(raw))
            mine = catalog_entries(json.loads((DOCS / rel).read_text(encoding="utf-8")))
        except (ValueError, AttributeError) as exc:
            print(f"::error::cannot parse {rel} on either side: {exc} — refusing to pass",
                  file=sys.stderr)
            return 2
        only_main = [n for n in mine if n not in live]
        if only_main:
            print(f"  MISS {rel}  →  {md_to_url(rel)}   "
                  f"[main {len(mine)} 条 / 线上 {len(live)} 条]")
            missing.append((rel, md_to_url(rel),
                            f"main 有而线上没有:{', '.join(only_main)}"))
        else:
            print(f"  ok   {rel}  →  {md_to_url(rel)}   "
                  f"[main {len(mine)} 条 / 线上 {len(live)} 条]")

    if checked == 0:
        print("::error::no page could be sampled (every candidate lacked a usable "
              "fingerprint) — refusing to pass", file=sys.stderr)
        return 2

    print(f"\nsampled {checked} recently-changed page(s) against {SITE}")
    if missing:
        for rel, url, fp in missing:
            # 三种缺法的文案不一样:整页 404 / 产物条目少 / 指纹句缺失。
            # 原来一律写死成 "this sentence is on main…",对前两种是错的描述。
            print(f"::error file=docs-site/docs/{rel}::main 上的这一份没有出现在 "
                  f"{SITE}{url} —— 合并后站点没有重新部署。"
                  f"在 origin/main 的工作树里跑 `vercel --prod`"
                  f"(见 deploy/docs-site/README.md)。差异:{fp[:100]!r}")
        print(f"\n{len(missing)} page(s) behind main.")
        return 1
    print("every sampled page on the live site matches main.")
    return 0


def selftest() -> int:
    cases = []

    def check(name, ok, detail=""):
        cases.append((name, ok, detail))

    check("md → url: 普通页", md_to_url("deploy/npm.md") == "/deploy/npm")
    check("md → url: 英文页", md_to_url("en/deploy/npm.md") == "/en/deploy/npm")
    check("md → url: 目录首页", md_to_url("guide/index.md") == "/guide/")
    check("md → url: 站点首页", md_to_url("index.md") == "/")

    # 🔴 `docs/public/` = VitePress 静态资源根:剥 `public/`、**保留扩展名**。
    # 这三条是本次修的那个 bug 的红夹具 —— 修之前它们全部 FAIL。
    check("public/ 下的 .md:剥 public/、保留 .md",
          md_to_url("public/skillhub/skills/x/1.0.0/SKILL.md")
          == "/skillhub/skills/x/1.0.0/SKILL.md",
          f"got={md_to_url('public/skillhub/skills/x/1.0.0/SKILL.md')!r}")
    check("public/ 下的 .json:扩展名不许被切",
          md_to_url("public/skillhub/catalog.json") == "/skillhub/catalog.json",
          f"got={md_to_url('public/skillhub/catalog.json')!r}")
    check("非 .md 且不在 public/:原样保留扩展名",
          md_to_url("assets/data.json") == "/assets/data.json",
          f"got={md_to_url('assets/data.json')!r}")

    # 产物判据:两种外形都要能读出条目名,且能看出 main 比线上多
    check("catalog: list 形状", catalog_entries([{"name": "b"}, {"name": "a"}]) == ["a", "b"])
    check("catalog: {'skills': …} 形状",
          catalog_entries({"skills": [{"name": "b"}, {"name": "a"}]}) == ["a", "b"])
    live_ = catalog_entries({"skills": [{"name": "a"}]})
    main_ = catalog_entries({"skills": [{"name": "a"}, {"name": "b"}]})
    check("catalog: 认得出 main 多出来的条目",
          [n for n in main_ if n not in live_] == ["b"])

    # 指纹:必须跳过标题/列表/引用/链接/强调,选一句纯正文
    text = ("# 标题\n"
            "- 一个列表项,它足够长足够长足够长足够长足够长足够长足够长\n"
            "> 引用行,它也足够长足够长足够长足够长足够长足够长足够长足够长\n"
            "见 [某处](https://example.com) 的说明,这一行带链接所以不该被选中吧\n"
            "这是一句普通正文,长度足够被选中,而且不含任何链接与强调符号。\n")
    fp = fingerprint(text)
    check("指纹跳过标题/列表/引用/链接,选中正文",
          fp == "这是一句普通正文,长度足够被选中,而且不含任何链接与强调符号。", f"got={fp!r}")
    check("全是结构行时返回 None", fingerprint("# a\n- b\n> c\n") is None)

    # 🔴 本次修的 bug 的红夹具(修之前这三条全 FAIL)
    fenced = ("```bash\n"
              "anet node stop <name> && anet daemon start <name>    # 这一行足够长足够长足够长\n"
              "```\n"
              "这是围栏之后的一句普通正文,长度足够被选中,不含链接与强调符号。\n")
    fp2 = fingerprint(fenced)
    check("指纹跳过代码围栏内部的行,选中围栏之后的正文",
          fp2 == "这是围栏之后的一句普通正文,长度足够被选中,不含链接与强调符号。", f"got={fp2!r}")
    check("整段只有围栏时返回 None(而不是选中一条命令)",
          fingerprint("```bash\nanet node stop <name> && anet daemon start <name>    # 足够长足够长足够长\n```\n") is None)
    check("~~~ 围栏同样被跳过",
          fingerprint("~~~sh\nsome very long command line that would otherwise be picked as a fingerprint right here\n~~~\n") is None)

    # 🔴 实体解码红夹具(修复前 FAIL):指纹含引号/尖括号时,渲染页给的是实体。
    ent_html = "<p>run [anet] &quot;&lt;alias&gt;&quot; is not running locally now ok</p>"
    ent_text = re.sub(r"<[^>]+>", " ", ent_html)
    ent_text = _html.unescape(ent_text)
    ent_text = re.sub(r"\s+", " ", ent_text)
    check("HTML 实体解码后指纹可命中",
          "[anet] \"<alias>\" is not running locally" in ent_text, f"got={ent_text!r}")
    check("太短的行不被选中", fingerprint("短句。\n") is None)

    # 🔴 多行 HTML 注释的续行(strip 后不以 `<` 开头)必须被跳过 —— 它渲染后
    #    不出现在页面上,选它当指纹就是恒 MISS 的假漂移(#1424 实测中招)。
    comment_text = ("<!-- 🔴 这两条戳被脚本读取,渲染出来看不见。\n"
                    "     release gate 会拿正在发的版本和这两条戳比对,不一致就拦下发布。 -->\n"
                    "这是渲染后真的会出现在页面上的一句普通正文,足够长且不含链接强调。\n")
    fp_c = fingerprint(comment_text)
    check("指纹跳过多行注释的续行,选中真正文",
          fp_c == "这是渲染后真的会出现在页面上的一句普通正文,足够长且不含链接强调。", f"got={fp_c!r}")
    check("整块都是注释时返回 None",
          fingerprint("<!-- release gate 会拿正在发的版本和这两条戳比对,不一致就拦下发布并列出。 -->\n") is None)

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}   {detail}")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else run())
