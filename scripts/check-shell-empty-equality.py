#!/usr/bin/env python3
"""空值相等：`[[ "$A" == "$B" ]]` 在两边**都没取到值**时静默判相同。

2026-10-31 —— 外部复核 ④：
    「bash 里 [[ "" == "" ]] 为真，比 PG 的 NULL = NULL 更危险：
      后者静默判**不同**（fail-closed），前者静默判**相同**（fail-open）。」
    「三态必须由『退出码 + 非空』构造。」

本门找的就是那种形态：**两边都是变量展开**、且这一行之前没有对任一侧做过
`-n` / `-z` / `"${A:-}"` 之类的非空守卫。
（字面量比较 `[[ "$MODE" == "apply" ]]` 不算 —— 右侧非空，空值不会误判相同。）

判据：**比较两个「可能取不到值」的东西，必须先证明其中至少一个有值；**
      否则「两边都失败」与「两边真的相同」在退出码上不可区分。

退出码：0 = 没有可疑点（或有但只是 advisory）/ 1 = --strict 且有可疑点 / 2 = 扫描器没跑（没有读数）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 比较行：[[ "$A" == "$B" ]] / [ "$A" = "$B" ] / [[ ${A} == ${B} ]]
CMP = re.compile(
    r"(?:\[\[\s*|\B\[\s+)"
    r"(\"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\"?)"
    r"\s*(==|=)\s*"
    r"(\"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\"?)"
    r"\s*(?:\]\]|\])"
)
# 守卫：对某个变量做过非空判断 / 默认值展开
def guarded(var: str, window: str) -> bool:
    pats = [
        rf"-n\s+\"?\$\{{?{var}\b",      # [ -n "$X" ]
        rf"-z\s+\"?\$\{{?{var}\b",      # [ -z "$X" ]
        rf"\$\{{{var}:-",               # ${X:-default}
        rf"\$\{{{var}:=",               # ${X:=default}
        rf"\$\{{{var}:\?",              # ${X:?err}
        rf"\[\[\s*-n\s+\"?\$\{{?{var}\b",
    ]
    return any(re.search(p, window) for p in pats)


def assigned_nonempty(var: str, text: str) -> bool:
    """这个变量在文件里有没有一次「非命令替换」的赋值（= 右值不是 $(...)）。

    为什么要这一格：`[[ "$got" == "$want" ]]` 里 want 来自字面量时，
    got 取空也只会**判不同**（fail-closed）—— 那不是本门要找的危险形态。
    危险的是**两边都可能取空**：那时「都失败」与「真的相同」退出码一样。
    """
    for m in re.finditer(rf"(?:^|\n)\s*(?:local\s+)?" + re.escape(var) + r"=(.+)$", text, re.M):
        rhs = m.group(1).strip()
        # 去掉外层引号再判断：`A="$(cmd)"` 也是命令替换（第一版就漏了这一格 ——
        # witness 脚本里两个变量都是 `"$(curl ...)"`，却被判成「字面量非空」而放过）
        inner = rhs.strip('"\'')
        if inner.startswith("$(") or inner.startswith("`"):
            continue
        if rhs in ('""', "''"):
            continue
        return True
    return False


def scan(root: Path) -> tuple[list[tuple[Path, int, str, str]], int]:
    files = 0
    hits: list[tuple[Path, int, str, str]] = []
    for p in sorted(root.rglob("*.sh")):
        if any(seg in p.parts for seg in ("node_modules", ".git", "dist", "build")):
            continue
        files += 1
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines):
            if line.lstrip().startswith("#"):
                continue
            for m in CMP.finditer(line):
                a, b = m.group(2), m.group(5)
                if not a or not b:
                    continue
                window = "\n".join(lines[max(0, i - 12): i + 1])
                if guarded(a, window) or guarded(b, window):
                    continue
                text = "\n".join(lines)
                if assigned_nonempty(a, text) or assigned_nonempty(b, text):
                    continue
                hits.append((p.relative_to(root), i + 1, a, b))
    return hits, files


SELFTEST_VECTORS = [
    # (源码, 期望命中?)
    ('if [[ "$A" == "$B" ]]; then echo same; fi', True),
    ('[[ -n "$A" ]] && if [[ "$A" == "$B" ]]; then :; fi', False),
    ('if [[ "$MODE" == "apply" ]]; then :; fi', False),
    ('A="${A:-default}"; if [[ "$A" == "$B" ]]; then :; fi', False),
    ('want="apply"; if [[ "$got" == "$want" ]]; then :; fi', False),
    # 第一版漏过的一格：带引号的命令替换曾被当成「字面量非空」
    ('A="$(curl -s x)"; B="$(curl -s y)"; if [[ "$A" == "$B" ]]; then :; fi', True),
]


def selftest() -> int:
    fails = 0
    for src, want in SELFTEST_VECTORS:
        hit = False
        for line in src.splitlines():
            for m in CMP.finditer(line):
                a, b = m.group(2), m.group(5)
                if a and b and not (guarded(a, src) or guarded(b, src)
                                    or assigned_nonempty(a, src) or assigned_nonempty(b, src)):
                    hit = True
        ok = hit == want
        print(f"  {'✓' if ok else '✗'} want={want} got={hit}  {src[:56]}")
        fails += 0 if ok else 1
    print(f"  selftest: {len(SELFTEST_VECTORS) - fails}/{len(SELFTEST_VECTORS)} 通过")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    strict = "--strict" in argv
    hits, files = scan(ROOT)
    if files == 0:
        print("✗ 扫描器没跑到任何 .sh —— 这不是「0 处」，是「没有读数」")
        return 2
    print(f"扫描 {files} 个 shell 脚本")
    # 2026-10-31 —— **分桶**：出口清单那条「豁免粒度必须与风险粒度一致」的同族应用。
    # 87 处可疑里绝大多数在 tests/（测试里的 before/after 比较，失败时通常已被 set -e 或
    # 前置断言挡住）。真正会 gate 不可逆动作的是 scripts/ 与 bin/ —— 桶不同，结论就不同。
    gate_hits = [h for h in hits if h[0].parts[0] in ("scripts", "bin")]
    test_hits = [h for h in hits if h not in gate_hits]
    print(f"  分桶：gate 路径（scripts/・bin/）{len(gate_hits)} 处 ｜ 其余（tests/・docs/）{len(test_hits)} 处")
    print("  ⇒ 「87 处」不是结论：**只有 gate 路径那几处会决定能不能做不可逆动作**。")
    if not hits:
        print("✓ 没有「两边都是变量、且都没做非空守卫」的相等比较")
    else:
        print(f"⚠ {len(hits)} 处可疑：两边都是变量、窗口内没有非空守卫")
        for p, ln, a, b in gate_hits + test_hits:
            print(f"    {p}:{ln}  [[ ${a} == ${b} ]]")
        print("  ⇒ 两边都取不到值时静默判相同（fail-open）；要么加 -n 守卫，要么改成三态。")
    return 1 if (strict and hits) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
