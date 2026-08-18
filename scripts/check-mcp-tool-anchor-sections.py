#!/usr/bin/env python3
"""符号锚点指的是不是它声称的那个 tool。

⚠️ 仓里有**两道**关于符号锚点的门,判据不同,不要弄混(本文件原名
   `check-doc-symbol-anchors.py`,与另一道重名,合并时改成了现在这个名字):

   .github/scripts/check-doc-symbol-anchors.py   —— 宽而浅
       范围:docs/ + docs-site/ 下**所有** md,锚点可指向**任意**源码文件
       判据:锚串在它左边那个链接指向的文件里**存在**

   scripts/check-mcp-tool-anchor-sections.py(本文件) —— 窄而深
       范围:只有 mcp-tools.md → server/src/tools.ts
       判据:锚串落在它声称的那个 **tool 段**里

   两者不能互相替代,这是实测出来的:把 `report_completion` 段的锚串换成
   `"send_task"` —— **本文件报 mismatches=1(红),那道宽的门照过**
   (因为那个串确实存在于 tools.ts)。反过来,一条指向 cli.ts 的坏锚点,
   本文件根本不看。

#831 把 `mcp-tools.md` 里的行号锚点换成了「文件链接 + 可 grep 的串」。那解决了
「行号会漂」,但引入了一个新的失效形态,而且它比行号漂移更隐蔽:

    锚串**确实存在**于源文件里,只是落在了别的 tool 段。

「锚串存在」这个检查会放行它。#845 里连着出了两例,都不是靠工具发现的:

    reassign_task 段  →  锚到 `status IN ('created', …)`,实际落在 send_message / cancel_task
    broadcast 段      →  锚到 `"ack_inbox"`,实际落在 ack_inbox

第一例我自己抓到就改了,**没有对全部锚点做一次审计**,于是第二例由审查者发现。
这个脚本就是那次审计,固化成门的一层 —— 一次性脚本抓到的错，下次还会漏。

## 判据

对 `docs-site/**/api/mcp-tools.md` 里每一条「链接 + 搜/grep `<串>`」:

  1. 找出这条引用所在的**文档章节**(最近的 `### <tool_name>` 标题)
  2. 找出锚串在 `server/src/tools.ts` 里的所有命中,以及每个命中落在**哪个 tool
     的注册段**(最近的 `registerTool("x"` / `tool("x"` 之前)
  3. 两者的交集为空 → 判为 mismatch

## 三类不是错的情形(都由实例催生,不是预设的)

  a) **明写了段名。** 文本里写「在 `report_status` 段搜」/「inside `report_status`」
     时,以那个名字为准,不用章节名。有些说明本来就是在 A 的章节里解释 B 写下的
     字段 —— `get_all_status` 段解释 `sessions.model` 由 `report_status` 写入就是。
  b) **锚串在 db.ts 里。** db.ts 没有 tool 段,按 tool 归属没有意义,跳过。
  c) **helper 函数。** `upsertNodeWithSec1Guard` 的实现在最后一个 tool 注册之后,
     按「最近的注册点」会被算到那个 tool 头上。所以命中落在**函数定义**上时,
     只要该函数在正确的 tool 段里被调用,就算匹配。

## 这个脚本不保证什么

它只管「锚串落在对的 tool 段」。锚串**在段内是否指着文档声称的那件事**,它判不了 ——
那仍然要人读。这跟 check-doc-source-pins.py 头部那个 5/10 召回率是同一类边界:
门缩小了错误的种类,没有消灭错误。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
TOOLS = REPO / "server" / "src" / "tools.ts"

# 只有 mcp-tools.md 是按 tool 分章节的;别的文档没有这个结构。
DOCS = ["docs-site/docs/api/mcp-tools.md", "docs-site/docs/en/api/mcp-tools.md"]

REG = re.compile(r'^\s*"([a-z_]+)",\s*$')
REG_PREV = re.compile(r"(registerTool|\btool)\($")
SECTION = re.compile(r"^#{2,4}\s+`?([a-z_]+)`?\s*$")
ANCHOR = re.compile(r"(?:搜|grep) `([^`]+)`")
EXPLICIT = re.compile(r"在 `([a-z_]+)` 段|inside `([a-z_]+)`")
LINK = re.compile(r"blob/main/(server/src/[a-z-]+\.ts)")
FUNC_DEF = re.compile(r"^\s*(?:const|function|async function|export function)\s+([A-Za-z_][A-Za-z0-9_]*)")


def tool_registrations(lines: list[str]) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(lines):
        m = REG.match(line)
        if m and i > 0 and REG_PREV.search(lines[i - 1].strip()):
            out.append((i + 1, m.group(1)))
    return out


def main() -> int:
    if not TOOLS.is_file():
        print(f"FAIL: 找不到 {TOOLS}", file=sys.stderr)
        return 1
    src_lines = TOOLS.read_text(encoding="utf-8").split("\n")
    regs = tool_registrations(src_lines)
    if not regs:
        # 分母承重:一个注册点都找不到时不能报绿 —— 那说明注册写法变了,
        # 而"零个 mismatch"和"根本没解析出 tool 段"打印出来是同一片绿。
        print("FAIL: 在 tools.ts 里一个 tool 注册点都没解析出来", file=sys.stderr)
        return 1
    print(f"tool_registrations={len(regs)}")

    def owner_of(line_no: int) -> str:
        prior = [r for r in regs if r[0] <= line_no]
        return prior[-1][1] if prior else "(file-head)"

    # helper 名 → 调用它的 tool 段集合
    helper_callers: dict[str, set[str]] = {}
    for i, line in enumerate(src_lines, 1):
        m = re.search(r"\b([A-Za-z_][A-Za-z0-9_]*)\(\{?\s*$", line)
        if m:
            helper_callers.setdefault(m.group(1), set()).add(owner_of(i))

    total = 0
    mismatches = 0
    checked_docs = 0

    for rel in DOCS:
        path = REPO / rel
        if not path.is_file():
            print(f"FAIL: 待检文档不存在:{rel}", file=sys.stderr)
            return 1
        checked_docs += 1
        doc_lines = path.read_text(encoding="utf-8").split("\n")
        sections = [
            (i + 1, m.group(1))
            for i, line in enumerate(doc_lines)
            if (m := SECTION.match(line))
        ]

        def section_of(line_no: int) -> str:
            prior = [s for s in sections if s[0] <= line_no]
            return prior[-1][1] if prior else "(preamble)"

        for line_no, line in enumerate(doc_lines, 1):
            targets = set(LINK.findall(line))
            # (b) 只引 db.ts 的行跳过 —— db.ts 没有 tool 段
            if targets and targets <= {"server/src/db.ts"}:
                continue
            # 一行里可能有多个锚串(例如 get_all_status 段那句同时引了自己的
            # SELECT 和 report_status 写下的 INSERT)。「在 `x` 段搜」这个限定
            # 只作用于**紧跟它的那一个**锚串,不能按整行套用 —— 第一版就是按
            # 整行匹配的,于是把 report_status 的限定套到了同行 get_all_status
            # 的锚串上,自己造出一条假 mismatch。
            anchors = list(ANCHOR.finditer(line))
            prev_end = 0
            for idx, m in enumerate(anchors):
                needle = m.group(1)
                hits = [i for i, x in enumerate(src_lines, 1) if needle in x]
                if not hits:
                    # 锚串不在 tools.ts 里 —— 可能是 db.ts 的串与 tools.ts 的串
                    # 同行混排。这里不判它,那是 check-doc-source-pins.py 之外的
                    # 另一件事;本脚本只管归属。
                    continue
                total += 1
                owners = {owner_of(h) for h in hits}

                # (c) 命中落在函数定义上时,看这个函数被哪些 tool 段调用
                for h in hits:
                    fm = FUNC_DEF.match(src_lines[h - 1])
                    if fm and fm.group(1) == needle:
                        owners |= helper_callers.get(needle, set())
                if needle in helper_callers:
                    owners |= helper_callers[needle]

                # 限定语可能在锚串**之前**(中文:「在 `x` 段搜 `串`」)也可能在
                # **之后**(英文:「grep `串` inside `x`」)。所以窗口取
                # 「上一个锚串结束 → 下一个锚串开始」,把两侧都包进来,但不跨到
                # 相邻锚串的地盘上。第一版只看前面,英文那条就漏判了。
                nxt = anchors[idx + 1].start() if idx + 1 < len(anchors) else len(line)
                window = line[prev_end:nxt]
                prev_end = m.end()
                ex = EXPLICIT.search(window)
                if ex:
                    # (a) 明写了段名,以它为准
                    want = {ex.group(1) or ex.group(2)}
                    label = f"明写 {sorted(want)}"
                else:
                    want = {section_of(line_no)}
                    label = f"章节 {sorted(want)}"
                    if want == {"(preamble)"}:
                        continue

                if not (owners & want):
                    mismatches += 1
                    print(
                        f"MISMATCH {rel}:{line_no}  {label} 但锚串落在 {sorted(owners)}"
                        f"  «{needle[:56]}»",
                        file=sys.stderr,
                    )

    print(f"checked_docs={checked_docs}")
    print(f"anchors_checked={total}")
    print(f"mismatches={mismatches}")

    if total == 0:
        print("FAIL: 一条锚串都没检查到 —— 检查 DOCS / ANCHOR 是不是坏了", file=sys.stderr)
        return 1
    if mismatches:
        print(file=sys.stderr)
        print("  锚串确实存在,但落在别的 tool 段里。这类错「锚串存在」的检查放行不了 ——", file=sys.stderr)
        print("  #845 里连着出了两例(reassign→cancel_task、broadcast→ack_inbox)。", file=sys.stderr)
        print("  改法:换一个落在正确段里的唯一串;确实要引别的 tool 时,在文本里", file=sys.stderr)
        print("  明写「在 `<tool>` 段搜」。", file=sys.stderr)
        return 1

    print()
    print(f"OK: {total} 条锚串全部落在它们声称的 tool 段里。")
    print("注意:这只管「落在对的段」。锚串在段内是否指着文档声称的那件事,仍要人读。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
