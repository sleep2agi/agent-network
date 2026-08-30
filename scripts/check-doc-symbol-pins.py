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



def judge(doc: Path, repo: Path, anchor: str, rel: str, n: int,
          lines: list[str], findings: list[str]) -> bool:
    """判一条 pin。返回 True=判定过了(不管漂没漂),False=没能判定。

    🔴 两条路径(ref=分支 / ref=commit)共用这一份判据。
       分成两份写的话,以后只会有一份被改到 —— 而两份的输出长得一样。
    """
    symbols = candidate_symbols(anchor, rel)
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
            findings.append(
                f"{head}\n       `{sym}` 在该文件出现 {len(where)} 处，"
                f"本门**不替你判断**该钉哪一处:\n{body}\n"
                f"       ⚠ 别直接抄第一个数字 —— 其中很可能有**提到该符号的注释行**。"
                f"钉到注释上门一样会绿，而文档从此指向一个不相干的位置。")
        break
    return judged


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    doc_root = "docs"
    if "--doc-root" in sys.argv:
        doc_root = sys.argv[sys.argv.index("--doc-root") + 1]
    repo = Path(args[0]).resolve() if args else Path.cwd()

    pins = skipped = unresolved = 0
    findings: list[str] = []
    for doc in tracked_docs(repo, doc_root):
        try:
            text = doc.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for anchor, ref, rel, lineno in PIN.findall(text):
            pins += 1
            if IMMUTABLE_REF.match(ref):
                # 钉在具体 commit 上 —— 拿那个 commit 的内容判,不拿工作树。
                lines_at_ref = content_at_ref(repo, ref, rel)
                if lines_at_ref is None:
                    unresolved += 1
                    continue
                judged_here = judge(doc, repo, anchor, rel, int(lineno), lines_at_ref, findings)
                if not judged_here:
                    skipped += 1
                continue
            target = repo / rel
            if not target.is_file():
                # 文件不存在是另一道门的活（check-doc-source-pins.py），
                # 在这里重复报会让两道门的数字互相污染。
                skipped += 1
                continue
            try:
                lines = target.read_text(encoding="utf-8", errors="replace").split("\n")
            except OSError:
                skipped += 1
                continue
            n = int(lineno)
            if not (1 <= n <= len(lines)):
                skipped += 1  # 越界同样归另一道门
                continue
            if not judge(doc, repo, anchor, rel, n, lines, findings):
                skipped += 1


    if pins == 0:
        print(f"::error::SYMBOL-PIN: 在 {doc_root}/ 下一个 blob 行号引用都没扫到 —— 范围塌了，拒绝通过")
        return 2
    for f in findings:
        print(f)
    verdict = "RED" if findings else "OK"
    print(f"SYMBOL-PIN: {verdict}（扫到 {pins} 个 pin，判定 {pins - skipped - unresolved} 个，"
          f"跳过 {skipped} 个，取不到 ref {unresolved} 个，漂移 {len(findings)} 个）")
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
