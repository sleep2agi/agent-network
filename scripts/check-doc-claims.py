#!/usr/bin/env python3
"""文档里「某文件某行写着某句」这类断言,现在还成立吗。

起因:#846 的审查指出这份仓库要求所有改动跑 Docker E2E,而
`docs/stale-issue-review.md` 是一份纯文档、没有可执行断言。我当时的回答是
「可以像 test831 那样把它变成门」,这就是那件事。

## 它检查什么

文档里嵌一个 ```doc-claims 代码块,每行三列(制表符或 ` :: ` 分隔):

    <相对路径> :: <行号> :: <该行必须包含的子串>

门逐条打开 `<相对路径>` 的第 `<行号>` 行,确认它包含 `<子串>`。

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

也就是说:**这道门绿,只说明文档引的行号还没漂。** 和
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


def parse(text: str) -> list[tuple[str, int, str]]:
    out: list[tuple[str, int, str]] = []
    for block in BLOCK.findall(text):
        for raw in block.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("::")]
            if len(parts) != 3:
                raise SystemExit(f"FAIL: 清单行格式不对(需要三列 :: 分隔):{raw!r}")
            out.append((parts[0], int(parts[1]), parts[2]))
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
            content = target.read_text(encoding="utf-8").split("\n")
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
        print("  文档引的行号漂了。改法:更新清单里的行号与子串,并同步正文;", file=sys.stderr)
        print("  别只改清单 —— 清单是给门看的,正文是给人看的,两边都要对。", file=sys.stderr)
        return 1

    print()
    print(f"OK: {total} 条文档断言全部仍成立。")
    print("注意:这只说明引的行号没漂。正文的结论对不对、引用之外的散文,门都不检查。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
