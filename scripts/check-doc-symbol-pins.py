#!/usr/bin/env python3
"""锚文本点名了一个符号,而钉住的行号上**没有那个符号**。

这是 `check-doc-source-pins.py` 自己在文件头里承认抓不到的那一类:

    抓不到的:
      锚点指着一行**长得很正常的代码**,只是不是它声称的那一行。

那道门的三条判据(文件不存在 / 行号越界 / 平凡行)都落在"这一行本身有问题"上。
而重构之后最常见的形态是:行号仍在范围内、那一行也是正常代码,**只是换了一段代码**。
读者点进去看到的东西看起来完全合理,所以连怀疑都不会产生。

🔴 这道门能补上的,只是其中**可机器判定**的一小块:锚文本里点了名的符号。
   `[loadProfile()](…#L228)` 是可判的;`[见这里](…#L228)` 不可判,直接跳过。
   ⇒ 跳过的数量会打印出来。**一个只说"0 处漂移"却不说"跳过了 120 处"的门,
     读起来像"全都查过了",而它其实只查了一小半。**

🔴 「能不能把跳过的那些也自动判了」—— 量过了,答案是不能。(2026-08-28)

   做法:锚文本取不出符号时,退回到**文档同一行反引号里的代码片段**取候选符号。
   我先用这个方法**手工**扫了一遍那 10 条,真找到 3 条漂移(cli.ts:1159 心跳、
   rename.ts:100 commitRename、db.ts:72 in_reply_to),已修。所以方法本身有效。

   但做成机器判据之后实测(三个 window 各跑一遍,同一棵已修好的树):

       window=±2   可判 10 条,报出 5 条 —— 其中 `YOUR_IP`(来自正文里的
                   http://YOUR_IP:9200)、`node`(通用词)、`send_task`(隔 10 行)
                   三条是误报
       window=±5   报出 4 条,误报 2 条
       window=±25  报出 3 条(去重后 2 条),**仍有 1 条是 `YOUR_IP` 误报**

   ⇒ 最好的窗口下,两条不同的报告里仍有一条是误报。
   **我手工能过是因为我会把 `YOUR_IP` / `node` 认出来不是符号,机器不能。**

   一道一半是误报的门,会在第一周被人关掉,然后连它对的那一半也一起没了。
   所以这条**留在注释里靠读,不做成门**:上面那句"跳过的不是通过"就是给人的
   提示,定期照它手工扫一遍即可 —— 2026-08-28 那次扫出 3 条真漂移,值得。

判据(刻意保守,宁可跳过也不误报):
  1. 锚文本里取出候选符号:长度 ≥3 的标识符,且不是被引用文件的文件名本身。
  2. 该符号必须在目标文件里**至少出现一次** —— 否则我们无法区分
     「符号被改名了」和「锚文本里那个词根本不是符号」,一律跳过。
  3. 钉住的行 ±WINDOW 行内出现该符号 → 通过。
     文件里别处出现 → 报漂移,并给出**它现在在第几行**。

退出码:0 无漂移 / 1 有漂移 / 2 判不了(一个 pin 都没扫到 = 范围塌了)

用法: check-doc-symbol-pins.py [仓库根，默认当前目录] [--doc-root docs]
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PIN = re.compile(
    r"\[([^\]\n]{1,120})\]\("
    r"https://github\.com/sleep2agi/agent-network/blob/"
    r"([0-9a-zA-Z._-]+)/([^\s)#\"']+)#L(\d+)\)"
    # 🔴 链接**之后**的一小段也算锚。本仓写法是把代码片段放在链接后面：
    #      [`…cli.ts:7882`](…#L7882) `sub === "dashboard"` 分支
    #    只捕获 `[...]` 里的标签就永远看不到那个片段 —— 而它恰恰是唯一能逐字定位的东西
    #    （`sub` 在 cli.ts 出现 89 次、`dashboard` 39 次，两个都超 UBIQUITOUS ⇒ 整条 pin
    #    被归进「跳过」而不告警，实测因此漏掉过一处 36 行的漂移）。
    # 🔴 `[^\n\[]` 而不是 `[^\n]`：architecture.md 有**同一行两个 pin** 的写法，
    #    贪婪尾窗会吃掉后一个 pin 的 `[` —— 实测 pin 总数从 15 掉到 13。
    r"([^\n\[]{0,100})"
)
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
# 🔴 #1024 —— ref 一直被捕获但从没被用过(那个组以前就叫 `_ref`)。
#    后果:钉在历史 commit 上的 pin 会被拿**当前工作树**去校验。
#    实例:docs-site/docs/changelog.md 把 `PINNED_SERVER_VERSION` 钉在
#    blob/3a387204/agent-network/bin/cli.ts#L61 —— 在 3a387204 上确实是第 61 行
#    (`61:const PINNED_SERVER_VERSION = "0.8.0";`),而当前 main 上它在 874 行。
#    这条现在不红,只是因为这道门根本没扫 docs-site/(取集问题,另一步)。
#    先把 ref 认对,再谈扩取集 —— 顺序反了会造出一批假红。
IMMUTABLE_REF = re.compile(r"^[0-9a-f]{7,40}$")


def content_at_ref(repo: Path, ref: str, rel: str) -> list[str] | None:
    """按 pin 声明的那个 commit 取文件内容。取不到返回 None —— 不回落到工作树。

    回落到工作树正是这个 bug 本身:它会让「我没拿到那个版本」
    伪装成「我检查过了」。浅克隆里取不到历史 commit 是常态,
    所以这种情况必须能和「检查通过」区分开。
    """
    try:
        out = subprocess.run(["git", "-C", str(repo), "show", f"{ref}:{rel}"],
                             capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.split("\n")
# 锚文本里几乎总会出现的词，它们不是符号名。
STOPWORDS = {
    "src", "bin", "dist", "lib", "docs", "main", "the", "and", "for", "see",
    "line", "lines", "file", "code", "here", "this", "that", "npm", "cli",
    "ts", "tsx", "js", "json", "md", "sh", "py",
}
WINDOW = 2
# 在目标文件里出现超过这么多次的标识符,不足以定位任何一行 —— 不拿它下判断。
UBIQUITOUS = 20


def tracked_docs(repo: Path, doc_root: str) -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files", f"{doc_root}/**/*.md", f"{doc_root}/*.md"],
            capture_output=True, text=True, check=True).stdout.split()
        if out:
            return [repo / p for p in out]
    except (OSError, subprocess.CalledProcessError):
        pass
    return sorted((repo / doc_root).rglob("*.md"))


LITERAL = re.compile(r"`([^`\n]{6,80})`")


def candidate_literals(anchor: str, rel: str = "") -> list[str]:
    """锚里可以**逐字**在源文件中定位的代码片段。

    只取含非标识符字符的（纯标识符交给 candidate_symbols，两条路径不重复判同一件事）。
    """
    out = []
    for frag in LITERAL.findall(anchor):
        frag = frag.strip()
        if not frag or IDENT.fullmatch(frag):
            continue
        # 🔴 只认**真的像代码**的片段。第一版只要求「含非标识符字符」,于是收进了
        #    文件名、URL 路径、线格式字符串,在 docs-site 那个 doc-root 上报出 5 条假漂移:
        #      `auth.ts`              ← 文件名(含 `.` 就过了第一版)
        #      `/events/<username>`   ← URL 路径
        #      `: keepalive\n\n`      ← 线格式字面量
        #    它们在目标文件里恰好出现一次是**巧合**(出现在注释或字符串里),
        #    而 pin 指的是那段逻辑,不是那处提及。
        if "/" in frag:
            continue                       # 路径/URL,不是代码片段
        if not re.search(r"[(){}=;]|=>|&&|\|\|", frag):
            continue                       # 没有任何代码语法
        if any(part and part in frag for part in Path(rel).name.split(".")):
            continue                       # 片段里带着被引用文件自己的名字
        out.append(frag)
    return out


def candidate_symbols(anchor: str, rel: str) -> list[str]:
    """从锚文本里挑出**可能是符号**的词。

    🔴 第一版只排了文件名和一张 stopword 表,于是把 `agent` 和 `channel` 当成了符号 ——
       它们来自锚文本里照抄的路径 `agent-network/bin/cli.ts`。那一版报了 26 处漂移,
       其中一多半是这么来的。**stopword 表治不了这个:路径里出现什么词是随仓库变的。**
       所以改成从**被引用路径自己**推出排除集,而不是维护一张名单。
    """
    excluded = {"", "md"}
    for part in re.split(r"[/.\-]", rel):
        if part:
            excluded.add(part)
            excluded.add(part.lower())
    out = []
    for word in IDENT.findall(anchor):
        if word.lower() in STOPWORDS or word in excluded or word.lower() in excluded:
            continue
        out.append(word)
    return out




def defines_symbol(line: str, sym: str) -> bool:
    """这一行是不是在**定义** `sym`(而不是调用它、或在注释里提到它)。

    🔴 判据必须精确到能排除这一行:

        const tag = dashboardReleaseTag();

    它以 `const` 开头,但定义的是 `tag`,不是 `dashboardReleaseTag`。
    我第一版用「以 const/function 开头」当判据,当场就把它误判成定义 ——
    而那正是本门一直拒绝自动消歧的理由。所以下面要求符号**紧跟在**
    声明关键字之后。
    """
    t = line.strip()
    if t.startswith("//") or t.startswith("*") or t.startswith("/*"):
        return False
    e = re.escape(sym)
    pats = (
        rf"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*{e}\b",
        rf"^(?:export\s+)?(?:abstract\s+)?class\s+{e}\b",
        rf"^(?:export\s+)?(?:const|let|var)\s+{e}\s*[:=]",
        rf"^(?:export\s+)?(?:type|interface|enum)\s+{e}\b",
    )
    return any(re.search(p, t) for p in pats)


def judge(doc: Path, repo: Path, anchor: str, rel: str, n: int,
          lines: list[str], findings: list[str], label_only: str = "",
          fixes: list | None = None) -> bool:
    """判一条 pin。返回 True=判定过了(不管漂没漂),False=没能判定。

    🔴 两条路径(ref=分支 / ref=commit)共用这一份判据。
       分成两份写的话,以后只会有一份被改到 —— 而两份的输出长得一样。
    """
    # 🔴 尾窗**只喂字面量**，不喂标识符。尾窗里的散文常常「提到」并不在 pin 那一行的
    #    符号，而且常是**否定**语气：
    #      docs/pitfalls.md    「`get_inbox` **故意不在列**」   ← 说的是它不在
    #      docs/architecture.md「SSE 推 `new_reply` 不是 `new_task`」← 说的是后果
    #    把这些当成「锚点名了该符号」会报出**假漂移**（实测一次报出 6 条，全是假的）。
    for frag in candidate_literals(anchor, rel):
        hits = [i + 1 for i, line in enumerate(lines) if frag in line]
        if len(hits) != 1:
            continue                      # 0 次分不清改写；多次不比标识符精确
        w = hits[0]
        if abs(w - n) <= WINDOW:
            return True
        findings.append(
            f"  🔴 {doc.relative_to(repo)}  锚文本逐字点名 `{frag}`，钉在 {rel}#L{n}，"
            f"但那一行是:\n       {lines[n - 1].strip()[:100]}\n"
            f"       该片段在该文件**恰好出现一处**，在第 {w} 行:\n"
            f"         {w:>5}  {lines[w - 1].strip()[:96]}")
        # 🔴 只有「恰好一处」才登记成可自动修。多处命中的那一支**故意不登记** ——
        #    见下面那段注释:替人挑一个数字会让门变绿而文档指向注释行。
        if fixes is not None:
            fixes.append((doc, rel, n, w))
        return True

    symbols = candidate_symbols(label_only or anchor, rel)
    judged = False
    for sym in symbols:
        # 🔴 词边界，不是子串。2026-08-18 实测:`createNetwork` 用子串匹配会命中
        #    `createNetworkTokenForNode`,于是这道门给出的「现在在第 224 行」
        #    指向的是**另一个函数**,而真正的 createNetwork 在 320 行。
        #    判漂移时它只会让判据变松;但那句提示是给人照抄的,**一个会被照抄的
        #    错行号,比不给提示更糟**。
        where = [i + 1 for i, line in enumerate(lines) if re.search(rf"\b{re.escape(sym)}\b", line)]
        if not where:
            continue  # 改名了还是根本不是符号——分不清，不猜
        if len(where) > UBIQUITOUS:
            # 出现几百次的词定位不到任何东西,拿它判漂移只会制造噪音。
            continue
        judged = True
        if any(abs(w - n) <= WINDOW for w in where):
            break
        head = (f"  🔴 {doc.relative_to(repo)}  锚文本点名 `{sym}`，钉在 {rel}#L{n}，"
                f"但那一行是:\n       {lines[n - 1].strip()[:100]}")
        if len(where) == 1:
            findings.append(f"{head}\n       `{sym}` 只出现一处，在第 {where[0]} 行:\n"
                            f"         {where[0]:>5}  {lines[where[0] - 1].strip()[:96]}")
            if fixes is not None:
                fixes.append((doc, rel, n, where[0]))
        else:
            # 🔴 多处匹配时**不给单一答案**。此前这里打印
            #    `min(where, key=|w-n|)`(离原 pin 最近的那处),而"最近"经常是
            #    **该符号上方的一句注释** —— 注释里自然会提到它。
            #    照着那个数字改 pin,门**会变绿**,而文档从此指着一句注释。
            #    2026-08-30 实测:`send_ack` 的注释在 2072、真正的工具注册在 2074,
            #    两者相距 2 行,谁"更近"完全取决于原 pin 落在哪 —— 而它们的含义天差地别。
            #    ⇒ 列出全部候选**并带上行内容**,把消歧交回给人。
            #      只给几个数字是不够的:人还是会挑第一个。
            body = "\n".join(f"         {w:>5}  {lines[w - 1].strip()[:96]}" for w in where)
            defs = [w for w in where if defines_symbol(lines[w - 1], sym)]
            if len(defs) == 1:
                # 🔴 这是对上面那条「不替你判断」的**一处收窄**,不是推翻它。
                #    多处命中里如果**恰好只有一处是该符号的定义**,那就不是在猜:
                #    定义是可以按语法判定的(见 defines_symbol),而本门最怕的
                #    「钉到注释上」恰恰被它排除掉。
                #    实测依据:`dashboardReleaseTag` 的行号锚从 2026-08-28 起被手工
                #    改过 2452→2489→2449→2452→2486→2499→2502→2507 共 8 次,
                #    每一次正确答案都是那唯一的定义行,而其余候选是 1 处调用 + 2 处注释。
                #    ⚠ 只在 `--fix` 下才会真的改;CI 跑的是不带 --fix 的版本。
                findings.append(
                    f"{head}\n       `{sym}` 在该文件出现 {len(where)} 处,"
                    f"其中**恰好一处是它的定义**:\n{body}\n"
                    f"       → 第 {defs[0]} 行是定义,--fix 会钉到那里(其余候选是调用/注释)。")
                if fixes is not None:
                    fixes.append((doc, rel, n, defs[0]))
            else:
                findings.append(
                    f"{head}\n       `{sym}` 在该文件出现 {len(where)} 处，"
                    f"本门**不替你判断**该钉哪一处:\n{body}\n"
                    f"       ⚠ 别直接抄第一个数字 —— 其中很可能有**提到该符号的注释行**。"
                    f"钉到注释上门一样会绿，而文档从此指向一个不相干的位置。")
        break
    return judged


def apply_fixes(fixes: list, repo: Path) -> int:
    """把「恰好一处」的漂移 pin 改写到它实际所在的行。返回改了几处。

    🔴 只改**这道门自己判定为无歧义**的那些。多处命中的一律不碰 ——
       `judge()` 里那段注释已经说清了为什么:替人挑一个数字会让门变绿,
       而文档从此可能指着一句注释。自动修如果比人更敢猜,就是在放大那个错。

    🔴 改写只发生在 PIN 匹配到的**那一段文本之内**,并且同时改两处:
         [`agent-network/bin/cli.ts:7882`](…/cli.ts#L7882)
                                  ^^^^                ^^^^
       本仓惯例把 `路径:行号` 也写进链接标签。只改 URL 会留下一个
       **同义副本**,门会变绿而标签仍然写着旧行号 —— 那比不修更糟,
       因为读文档的人看的是标签。

    🔴 改完之后还会扫一遍**同一个文档里别处出现的那个旧行号**(例如正文里
       记录漂移史的 `7845→7882`)。那些**不自动改**(有的是有意保留的历史),
       但必须说出来,否则「门绿了」会被读成「文档一致了」。
    """
    from collections import defaultdict
    by_doc: dict = defaultdict(list)
    for doc, rel, old_n, new_n in fixes:
        by_doc[doc].append((rel, old_n, new_n))
    changed = 0
    for doc, items in by_doc.items():
        text = doc.read_text(encoding="utf-8", errors="replace")
        original = text
        for rel, old_n, new_n in items:
            if old_n == new_n:
                continue

            def rewrite(m: re.Match) -> str:
                span = m.group(0)
                if m.group(3) != rel or int(m.group(4)) != old_n:
                    return span
                span = span.replace(f"#L{old_n}", f"#L{new_n}")
                span = span.replace(f":{old_n}", f":{new_n}")
                return span

            text = PIN.sub(rewrite, text)
        if text != original:
            doc.write_text(text, encoding="utf-8")
            changed += len(items)
            for rel, old_n, new_n in items:
                print(f"  ✅ {doc.relative_to(repo)}  {rel}#L{old_n} → #L{new_n}")
                # 🔴 只报**看起来像行号引用**的残留,不报散文里碰巧出现的同一个数字。
                #    第一版用 `str(old_n) in line`,在行号是 `2` 这种小数字时
                #    会把「line2」「第 2 行」全报出来 —— 一个吵到没人看的告警
                #    等于没有告警。判据:数字两侧不是数字,且紧邻 `:` `L` `#` `→`
                #    之一(本仓的两种写法:`cli.ts:7882` 和漂移史 `7845→7882`)。
                leftover_re = re.compile(
                    rf"(?:[:L#]|→)\s*{old_n}(?![0-9])|(?<![0-9]){old_n}\s*(?:→)")
                leftovers = [i + 1 for i, line in enumerate(text.split("\n"))
                             if leftover_re.search(line)]
                if leftovers:
                    print(f"     ⚠ 该文档里仍有 {len(leftovers)} 行提到 {old_n}"
                          f"(第 {', '.join(map(str, leftovers[:6]))} 行)——"
                          f"**没有自动改**。可能是有意保留的漂移史,也可能是漏网的同义副本,"
                          f"请人看一眼。")
    return changed


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    doc_root = "docs"
    if "--doc-root" in sys.argv:
        doc_root = sys.argv[sys.argv.index("--doc-root") + 1]
    repo = Path(args[0]).resolve() if args else Path.cwd()

    do_fix = "--fix" in sys.argv
    pins = skipped = unresolved = 0
    # 🔴 「跳过」此前是一个数，而它底下是**三种含义完全不同**的东西：
    #   blind      —— 锚文本没点名符号，机器分不清「改名了」和「那不是符号」。**这是真盲区。**
    #   other-gate —— 文件不存在 / 行号越界，设计上归 check-doc-source-pins.py。**不是盲区。**
    #   ioerror    —— 读不了，环境问题。
    # 并成一个数之后，输出里那句「跳过的不是通过」读者**无法据以行动** ——
    # 他不知道该去补哪一类。这里只做分桶与列表，判据与退出码一个字没动。
    skipped_by: dict[str, list[str]] = {"blind": [], "other-gate": [], "ioerror": []}
    def skip(kind: str, doc, rel, lineno) -> None:
        skipped_by[kind].append(f"{doc.relative_to(repo)}: {rel}#L{lineno}")
    findings: list[str] = []
    fixes: list = []
    for doc in tracked_docs(repo, doc_root):
        try:
            text = doc.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for anchor, ref, rel, lineno, trail in PIN.findall(text):
            label_only = anchor
            anchor = anchor + " " + trail
            pins += 1
            if IMMUTABLE_REF.match(ref):
                # 钉在具体 commit 上 —— 拿那个 commit 的内容判,不拿工作树。
                lines_at_ref = content_at_ref(repo, ref, rel)
                if lines_at_ref is None:
                    unresolved += 1
                    continue
                judged_here = judge(doc, repo, anchor, rel, int(lineno), lines_at_ref, findings, label_only, fixes)
                if not judged_here:
                    skipped += 1
                    skip("blind", doc, rel, lineno)
                continue
            target = repo / rel
            if not target.is_file():
                # 文件不存在是另一道门的活（check-doc-source-pins.py），
                # 在这里重复报会让两道门的数字互相污染。
                skipped += 1
                skip("other-gate", doc, rel, lineno)
                continue
            try:
                lines = target.read_text(encoding="utf-8", errors="replace").split("\n")
            except OSError:
                skipped += 1
                skip("ioerror", doc, rel, lineno)
                continue
            n = int(lineno)
            if not (1 <= n <= len(lines)):
                skipped += 1  # 越界同样归另一道门
                skip("other-gate", doc, rel, lineno)
                continue
            if not judge(doc, repo, anchor, rel, n, lines, findings, label_only, fixes):
                skipped += 1
                skip("blind", doc, rel, lineno)


    if pins == 0:
        print(f"::error::SYMBOL-PIN: 在 {doc_root}/ 下一个 blob 行号引用都没扫到 —— 范围塌了，拒绝通过")
        return 2
    for f in findings:
        print(f)
    if do_fix and fixes:
        print(f"\n--fix: 其中 {len(fixes)} 处是「恰好一处」的无歧义漂移,改写如下:")
        apply_fixes(fixes, repo)
        print("🔴 --fix 只碰两种:「恰好一处命中」和「多处命中但**恰好一处是定义**」。")
        print("     其余多处命中的仍然不碰 —— 那需要人来消歧(理由见 judge() 的注释)。")
        print("   改完请重跑一次不带 --fix 的本门确认。")
    elif do_fix:
        print("\n--fix: 没有可自动修的漂移(要么没漂,要么全是需要人消歧的多处命中)。")
    # 🔴 各桶之和必须等于 skipped:将来有人加了新的 skip 点却忘了打标,
    #    分解会静默少数 —— 那正是「分桶」最容易坏掉又最难发现的方式。
    _bucketed = sum(len(v) for v in skipped_by.values())
    if _bucketed != skipped:
        print(f"::error::SYMBOL-PIN: 跳过分桶不自洽（skipped={skipped} 但分桶只有 {_bucketed} 条）"
              f"—— 有 skip 点没调 skip()，分解不可信")
        return 2
    verdict = "RED" if findings else "OK"
    print(f"SYMBOL-PIN: {verdict}（扫到 {pins} 个 pin，判定 {pins - skipped - unresolved} 个，"
          f"跳过 {skipped} 个，取不到 ref {unresolved} 个，漂移 {len(findings)} 个）")
    if skipped:
        # 🔴 分桶只为让上面那句「跳过的不是通过」可被据以行动:
        #    blind 是这道门**真正看不见**的部分,other-gate 是设计上的分工。
        #    把两者并成一个数,读者会把后者也当成隐患。
        nb, no_, ni = (len(skipped_by[k]) for k in ("blind", "other-gate", "ioerror"))
        print(f"   跳过分解：锚文本没点名符号 {nb} 个（**这是本门的真盲区**）、"
              f"归 check-doc-source-pins.py {no_} 个（文件不存在/行号越界）、读不了 {ni} 个"
              f"{'' if '--list-skipped' in sys.argv else ' —— 加 --list-skipped 看是哪些'}")
        if "--list-skipped" in sys.argv:
            for kind in ("blind", "other-gate", "ioerror"):
                for item in skipped_by[kind]:
                    print(f"   [{kind}] {item}")
    if unresolved:
        # 🔴 单列一格,不并进「跳过」。「我没拿到那个 commit」和「锚文本没点名符号」
        #    是两件事,并成一个数之后,浅克隆导致的**全体取不到**会伪装成
        #    「都跳过了,没问题」—— 而那正是这道门最该报警的时候。
        print(f"🔴 有 {unresolved} 条 pin 钉在取不到的 commit 上(浅克隆?)——"
              f"它们**没有被检查**,不是通过。CI 上出现这个数就该去看 fetch-depth。")
    print("🔴 跳过的那些不是通过 —— 锚文本没点名符号，或符号在目标文件里一次都没出现，"
          "机器分不清「改名了」和「那个词本来就不是符号」。")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
