#!/usr/bin/env python3
"""文档站里 blob/<ref>/<file>#L<N> 形式的源码行号引用,有没有指到不存在的东西。

背景:#831。docs-site 下 141 处这类引用**全部**钉在 `main` 上,没有一个钉在
不可变的 commit。钉 main 的锚点在每次重构后都会漂,而漂了不会有任何东西报错 ——
读者点进去看到的是一行毫不相干的代码,文档却仍然理直气壮。

🔴 这道门只抓得住其中一类,而且只有一半。务必先读下面这段再改它。

能抓到的(机械可证):
  1. 文件在树里不存在
  2. 行号超出文件行数
  3. 那一行是"平凡行" —— `}` / `}],` / `);` / 空行 / 某段注释的中间一行。
     判据的理由:没有人会**故意**把一段说明文字的锚点钉在 `}` 或空行上。

抓不到的:
  锚点指着一行**长得很正常的代码**,只是不是它声称的那一行。
  这是最常见的失效形态,只有人读了上下文才判得出。

召回率是实测的,不是估计的。拿 #831 里已人工确认失效的 10 条回测这套判据:

    tools.ts#L521   抓到(平凡行)
    tools.ts#L286   ✘ 漏掉   network_id: z.string().max(200).optional(),
    tools.ts#L646   ✘ 漏掉   cpu_pct: processCpuPct,
    tools.ts#L571   抓到(平凡行)
    tools.ts#L911   ✘ 漏掉   message_id: z.string().min(1).max(200),
    tools.ts#L244   ✘ 漏掉   FROM skillhub_skills WHERE network_id = ?1`;
    tools.ts#L271   ✘ 漏掉   const reviewer = !callerTokenIsNetwork && (role === …
     auth.ts#L99    抓到(平凡行)
     push.ts#L11    抓到(平凡行)
    index.ts#L253   抓到(越界)

    抓到 5/10,漏掉 5/10

**所以这道门全绿不等于文档站的行号引用是对的。** 它承诺的只有一件事:
已知失效的那批不会变多。别把它当成 #831 的解决方案 —— #831 的解决方案是
把行号锚点换成符号锚点,这道门只是在那之前守住下限。

基线的语义:docs/doc-source-pins-baseline.txt 记着当前已知失效的那批。
  - 出现基线之外的新失效 → 红。这是这道门存在的理由。
  - 基线里的某条已经修好 → 也红,并要求把它从基线里删掉。
    不这么做的话基线会变成坟场:修好的和没修的混在一起,数字再也不说明任何事。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
BASELINE = REPO / "docs" / "doc-source-pins-baseline.txt"
DOC_ROOT = "docs-site"

PIN = re.compile(
    r"https://github\.com/sleep2agi/agent-network/blob/"
    r"([0-9a-zA-Z._-]+)/([^\s)#\"']+)#L(\d+)"
)

# 平凡行:只有闭合符号、空白,或整行是注释。
# 整行注释也算"平凡",因为锚点落在一段注释的中间一行,几乎总是漂移的结果 ——
# 引用一段注释时人会锚在它的第一行。这条会有误判,所以它进的是基线而不是硬红。
TRIVIAL = re.compile(r"^\s*(?:[}\])]+[;,)]*\s*|//.*|/\*.*|\*.*)?$")

SCANNED_SUFFIXES = (".md", ".ts", ".tsx", ".js", ".json", ".vue")


def tracked_docs() -> tuple[list[str], str]:
    """返回 (待扫文件列表, 用的是哪条路径)。

    有 .git 就用 git ls-files —— 那是权威的"仓里有什么"。
    没有 .git(比如在只 COPY 了源码树的容器里)就退化成目录遍历。

    两条路径在干净检出上应当给出同一份清单。tests/test831-doc-source-pins
    的 L0 会同时跑这两条并断言文件数相等 —— 否则容器内外扫的范围会悄悄分叉,
    而"容器里绿"就不再能推出"仓库里绿"。
    """
    if (REPO / ".git").exists():
        out = subprocess.run(
            ["git", "-C", str(REPO), "ls-files", DOC_ROOT],
            capture_output=True, text=True, check=True,
        ).stdout.split()
        return ([f for f in out if f.endswith(SCANNED_SUFFIXES)], "git")

    root = REPO / DOC_ROOT
    walked = [
        str(path.relative_to(REPO))
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and path.name.endswith(SCANNED_SUFFIXES)
        and "node_modules" not in path.parts
        and ".vitepress/cache" not in str(path)
        and "dist" not in path.parts
    ]
    return (walked, "walk")


def collect_pins(files: list[str]) -> tuple[dict[tuple[str, int], set[str]], int]:
    """返回 (pin → 引用它的文档集合, 原始出现次数)。

    两个数是不一样的,别混:同一个 pin 在同一个文档里出现两次,前者只记一次。
    第一版这里把 sum(len(v)) 当成了"引用总数"打印出来,得到 139,而原始出现
    次数是 141 —— 差的两处正是同文件内的重复。数对不上是自己发现的:同一份
    数据我先后量出两个数。
    """
    pins: dict[tuple[str, int], set[str]] = {}
    occurrences = 0
    for rel in files:
        try:
            text = (REPO / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for match in PIN.finditer(text):
            _ref, path, line = match.groups()
            pins.setdefault((path, int(line)), set()).add(rel)
            occurrences += 1
    return pins, occurrences


def classify(path: str, line: int) -> tuple[str, str] | None:
    """返回 (失效类别, 那一行的内容);指不出问题时返回 None。"""
    target = REPO / path
    if not target.is_file():
        return ("missing-file", "")
    try:
        content = target.read_text(encoding="utf-8").split("\n")
    except (OSError, UnicodeDecodeError):
        return ("unreadable", "")
    if line > len(content):
        return ("line-out-of-range", f"(文件只有 {len(content)} 行)")
    text = content[line - 1]
    if TRIVIAL.match(text):
        return ("trivial-line", text.strip())
    return None


def read_baseline() -> set[str]:
    if not BASELINE.is_file():
        return set()
    entries = set()
    for raw in BASELINE.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip() if raw.lstrip().startswith("#") else raw.strip()
        if line and not raw.lstrip().startswith("#"):
            entries.add(line)
    return entries


def main() -> int:
    files, mode = tracked_docs()
    pins, occurrences = collect_pins(files)
    print(f"listing_mode={mode}")
    print(f"scanned_doc_files={len(files)}")
    print(f"pin_occurrences={occurrences}")
    print(f"pin_doc_pairs={sum(len(v) for v in pins.values())}")
    print(f"unique_pins={len(pins)}")

    # 分母承重:扫不到任何 pin 时不能报绿 —— 那多半是 DOC_ROOT 写错或后缀表漏了,
    # 而"零个坏 pin"和"根本没扫到东西"打印出来是同一片绿。
    if not pins:
        print("FAIL: 一个 pin 都没扫到 —— 检查 DOC_ROOT / SCANNED_SUFFIXES 是不是坏了", file=sys.stderr)
        return 1

    broken: dict[str, tuple[str, str]] = {}
    for (path, line), _docs in sorted(pins.items()):
        verdict = classify(path, line)
        if verdict:
            broken[f"{path}#L{line}"] = verdict

    print(f"broken_pins={len(broken)}")

    baseline = read_baseline()
    print(f"baseline_entries={len(baseline)}")

    new = sorted(set(broken) - baseline)
    fixed = sorted(baseline - set(broken))

    if new:
        print()
        print(f"FAIL: {len(new)} 个新的失效 pin(不在基线里)", file=sys.stderr)
        for key in new:
            kind, text = broken[key]
            print(f"  [{kind}] {key}  {text}", file=sys.stderr)
        print(file=sys.stderr)
        print("  改法:把行号锚点换成符号锚点(读者用 git grep 定位,重构改不坏),", file=sys.stderr)
        print("  或者钉一个不可变的 commit SHA。别把新条目加进基线 —— 基线只许缩小。", file=sys.stderr)

    if fixed:
        print()
        print(f"FAIL: {len(fixed)} 个基线条目已经不再失效,请从基线里删掉", file=sys.stderr)
        for key in fixed:
            print(f"  {key}", file=sys.stderr)
        print(file=sys.stderr)
        print("  不删的话基线会变成坟场:修好的和没修的混在一起,数字再也不说明任何事。", file=sys.stderr)

    if new or fixed:
        return 1

    print()
    print(f"OK: 失效 pin {len(broken)} 个,与基线完全一致 —— 没有新增,也没有该清的残留。")
    print("注意:这只说明已知失效的那批没变多。它抓不到「锚点指着一行正常代码、")
    print("只是不是声称的那一行」—— 实测召回率 5/10,详见本文件头部。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
