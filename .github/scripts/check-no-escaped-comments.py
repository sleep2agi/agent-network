#!/usr/bin/env python3
"""Python 注释里不许出现字面 `\\uXXXX`。

2026-08-18 我自己在 #996 / #997 里连着两次写出这种注释，合进了 main：

    # \\u5df2\\u77e5\\u7f3a\\u53e3\\uff0c\\u5199\\u5728\\u8fd9\\u91cc…

同一个 `\\uXXXX` 出现在**字符串字面量**里是对的 —— Python 在解析时就把它解成了字符，
selftest 打印出来的中文完全正常。**只有注释不会被任何东西解码**，它原样躺在那里。
于是这个错的两副面孔里，被修掉的那份（字符串）本来就没坏，而留下来的那份
（注释）恰恰是唯一给人读的。

判据用 tokenize 取 COMMENT token，不用正则扫行 —— 行里可能同时有
`"# \\u4e0d\\u662f\\u811a\\u672c"` 这样**字符串内的** `#`，按行 grep 会把它当注释误报。
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import tokenize
from pathlib import Path

ESC = re.compile(r"\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}")


def main() -> int:
    r = subprocess.run(["git", "ls-files", "*.py"], capture_output=True, text=True)
    files = [f for f in r.stdout.split("\n") if f]
    # 分母承重：一个文件都没取到时不能报绿。
    if not files:
        print("::error::git ls-files '*.py' 一个都没返回 —— 取集坏了，不当作通过")
        return 2

    bad = 0
    for rel in files:
        p = Path(rel)
        try:
            src = p.read_text(encoding="utf-8")
            toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
        except (OSError, SyntaxError, tokenize.TokenError, UnicodeDecodeError):
            continue
        for t in toks:
            if t.type == tokenize.COMMENT and ESC.search(t.string):
                bad += 1
                print(f"::error file={rel},line={t.start[0]}::注释里有字面 "
                      f"\\uXXXX，它不会被任何东西解码：{t.string[:70]}")

    print(f"scanned {len(files)} python file(s); {bad} escaped comment(s).")
    if bad:
        print("    注释直接写字符。字符串字面量里的 \\uXXXX 是对的，不要一起改。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
