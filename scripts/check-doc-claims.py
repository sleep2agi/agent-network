#!/usr/bin/env python3
"""文档里的源码定位断言（精确行或唯一子串）现在还成立吗。

起因:#846 的审查指出这份仓库要求所有改动跑 Docker E2E,而
`docs/stale-issue-review.md` 是一份纯文档、没有可执行断言。我当时的回答是
「可以像 test831 那样把它变成门」,这就是那件事。

## 它检查什么

文档里嵌一个 ```doc-claims 代码块,每行 **两列或三列**(` :: ` 分隔):

    <相对路径> :: <该行必须包含的子串>            ← 推荐:靠「唯一」定位,不写行号
    <相对路径> :: <行号> :: <该行必须包含的子串>   ← 旧式:靠行号定位

三列式:打开第 `<行号>` 行,确认它包含 `<子串>`。
两列式:在整个文件里找 `<子串>`,**必须恰好出现一次** —— 唯一性就是定位。

🔴 为什么加两列式(2026-08-18,三天里漂了两次):
   行号 pin 会被**上方任何增删**打漂,而漂了之后的红,和「文档说错了」的红
   **在输出上长得一样**。两次实例:
     #950  在 ~:462 插了 12 行 → 三条 cli.ts pin 整体 +12
     #984  对 cli.ts 净 +1 行   → 同样三条被打散成 +1 / -1 / +1（两个方向都有）
   第二次尤其说明问题:**一个净 +1 行的改动,让三条本来正确的引用同时变错。**

   两列式把「唯一」当定位,所以上方增删不影响它。代价是子串必须够长到唯一 ——
   这不是缺点:`addNetworkScope` 在 server.ts 里出现 24 次,拿它当锚点本来就
   什么都没钉住,行号只是掩盖了这一点。

   两种写法都留着:行号式在「就是要盯这一行」时仍然有意义,而且 test846 的
   drifted 变异用的就是它。

## 为什么要显式清单,而不是从正文正则抽

正文里的引用是**裸文件名**:`cli.ts:3450`、`db.ts:393`。而 `cli.ts` 在
`agent-network/bin/` 和 `agent-node/src/` 各有一个,`db.ts` 也不止一处 ——
正则抽出来根本不知道该开哪个文件。第一版我想从正文直接抽,试到这里才发现。

代价说清楚:**清单和正文可能各写各的。** 门检查的是清单,不是正文的每一句。
所以清单里的每一条都应当是正文真的引用过的那几条 —— 加条目时顺手核一下。

## 🔴 它不检查什么

- **不检查正文的结论对不对。** 「`db.ts:393` 有 `ADD COLUMN team`」成立,不代表
  「#175 已交付」这个判断成立 —— 后者要人读 issue 正文。
- **不检查引用之外的散文。** 文档里大量的「为什么」「怎么做」,门碰不到。

也就是说:**这道门绿,只说明文档列出的源码定位仍成立。** 和
`scripts/check-doc-source-pins.py` 的边界是同一类 —— 门缩小了错误的种类,
没有消灭错误。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0]).resolve() if ARGS else Path.cwd()
DOCS = ARGS[1:] if len(ARGS) > 1 else ["docs/stale-issue-review.md"]

BLOCK = re.compile(r"^```doc-claims\s*$(.*?)^```\s*$", re.M | re.S)


def parse(text: str) -> list[tuple[str, int | None, str]]:
    """两列 → (路径, None, 子串);三列 → (路径, 行号, 子串)。"""
    out: list[tuple[str, int | None, str]] = []
    for block in BLOCK.findall(text):
        for raw in block.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("::")]
            if len(parts) == 2:
                out.append((parts[0], None, parts[1]))
            elif len(parts) == 3:
                out.append((parts[0], int(parts[1]), parts[2]))
            else:
                raise SystemExit(f"FAIL: 清单行格式不对(需要两列或三列 :: 分隔):{raw!r}")
    return out


def main() -> int:
    total = 0
    bad = 0
    for rel in DOCS:
        doc = REPO / rel
        if not doc.is_file():
            print(f"FAIL: 待检文档不存在:{rel}", file=sys.stderr)
            return 1
        claims = parse(doc.read_text(encoding="utf-8"))
        print(f"doc={rel} claims={len(claims)}")
        # 分母承重:一条断言都没抽到时不能报绿 —— 那多半是代码块标记写错了,
        # 而「0 条断言全过」和「压根没抽到」打印出来是同一片绿。
        if not claims:
            print(f"FAIL: {rel} 里没有 ```doc-claims 块,或块是空的", file=sys.stderr)
            return 1
        for path, line_no, needle in claims:
            total += 1
            # 路径必须留在仓内 —— 与 check-doc-source-pins.py 同一处教训
            if path.startswith("/") or ".." in Path(path).parts:
                print(f"FAIL: [path-escapes-repo] {path}", file=sys.stderr)
                bad += 1
                continue
            target = REPO / path
            if not target.is_file():
                print(f"FAIL: [missing-file] {path}:{line_no}", file=sys.stderr)
                bad += 1
                continue
            body = target.read_text(encoding="utf-8")
            if line_no is None:
                # 两列式:唯一性就是定位。0 次 = 引用失效;>1 次 = 这个锚点本来就
                # 没钉住任何地方,行号只是把这件事掩盖了。
                hits = body.count(needle)
                if hits == 0:
                    print(f"FAIL: [not-found] {path} 里找不到 «{needle}»", file=sys.stderr)
                    bad += 1
                elif hits > 1:
                    print(f"FAIL: [ambiguous] {path} 里 «{needle}» 出现 {hits} 次 —— "
                          f"锚点必须唯一,请加长子串", file=sys.stderr)
                    bad += 1
                continue
            content = body.split("\n")
            if line_no < 1 or line_no > len(content):
                print(
                    f"FAIL: [line-out-of-range] {path}:{line_no} (文件 {len(content)} 行)",
                    file=sys.stderr,
                )
                bad += 1
                continue
            text = content[line_no - 1]
            if needle not in text:
                print(f"FAIL: [drifted] {path}:{line_no} 不含 «{needle}»", file=sys.stderr)
                print(f"       实际: {text.strip()[:100]}", file=sys.stderr)
                bad += 1

    print(f"claims_checked={total}")
    print(f"claims_failed={bad}")
    if bad:
        print(file=sys.stderr)
        print("  文档的源码定位断言失效。改法:更新清单里的行号或唯一子串,并同步正文;", file=sys.stderr)
        print("  别只改清单 —— 清单是给门看的,正文是给人看的,两边都要对。", file=sys.stderr)
        return 1

    print()
    print(f"OK: {total} 条文档断言全部仍成立。")
    print("注意:这只说明源码定位断言仍成立。正文的结论对不对、引用之外的散文,门都不检查。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
