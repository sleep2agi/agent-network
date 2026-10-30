#!/usr/bin/env python3
"""`trap … ERR` 会把 RC 采集吃掉 —— 一条静态门。

2026-10-31 —— 起因（外部复核，原话）：
    set -E; trap 'exit 1' ERR
    git diff --quiet ...
    RC=$?    # 到不了；trap 先退出，RC 只剩 1

后果不是「少一个数字」，是**把「已失效（2）」误改成「未预期（1）」** ——
于是动作从「更新卡」错到「查脚本」。

本脚本查两件事（都在**同一个文件内**）：
  ① 出现 `trap … ERR` 且同时开 `set -e` ⇒ 该文件里所有 `RC=$?` 都不可信（红）
  ② 出现 `rc=$?` 但前一条命令既不在 `if` 里、也不在 `||`/`&&` 之后、也没有 `set +e` 包裹
     ⇒ 这条采集**可能**拿不到真实 rc（橙：报告，不判红）

为什么 ① 判红而 ② 只报告：
  ① 是**结构性**的 —— 整份文件的采集语义被改掉，修法是改结构；
  ② 可能是**有意的** —— 该脚本没开 `set -e` 时 `rc=$?` 完全正确（本仓 preflight-local.sh 就是这种）。
  「报告但不判红」的那些条目，行号一并打出来，读者一眼能核。

用法：python3 scripts/check-shell-rc-capture.py [--json]
退出码：0 = 没有结构性缺陷；1 = 有（①）；2 = 扫描域为空（没有读数）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TRAP_ERR = re.compile(r"\btrap\b[^\n]*\bERR\b")
SET_E = re.compile(r"^\s*set\s+-[a-z]*e[a-z]*\b|\bset\s+-o\s+errexit\b", re.M)
RC_CAPTURE = re.compile(r"\b(?:rc|RC|_rc|_RC|rc_wait)\s*=\s*\$\?")
GUARDED = re.compile(r"\|\||&&|\bif\b|\bwhile\b|\buntil\b")


def tracked_shell() -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files", "*.sh"], cwd=REPO, capture_output=True, text=True, timeout=30).stdout
        return [REPO / line for line in out.split("\n") if line.strip()]
    except Exception:  # noqa: BLE001
        return sorted(REPO.glob("**/*.sh"))


def scan(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    lines = text.splitlines()
    trap_m = TRAP_ERR.search(text)
    has_trap_err = bool(trap_m)
    # 2026-10-31 —— 不是所有 trap ERR 都吃 rc：
    #   本仓的两个 QA runner 写成 `trap '_rc=$?; …; exit $_rc' ERR` —— 它在 trap **内部**抓 rc 并原样传出。
    #   那种写法的风险只剩「trap 之后的行不会执行」，不是「rc 被改成 1」。
    # ⇒ 结构性风险只在 trap 不把 rc 传出去时才成立（`trap 'exit 1' ERR` 那种）。
    trap_line = ""
    if trap_m:
        pos = trap_m.start()
        trap_line = text[pos:text.index("\n", pos)] if "\n" in text[pos:] else text[pos:]
    # 判定「这个 trap 会不会改掉退出码」，三个层次：
    #   · trap 体内 `exit <常量>` 且**没有**引用 $? / 变量 ⇒ 会把真实 rc 换成常量（就是被复核的那个 bug）
    #   · `exit $_rc` / `exit $?` ⇒ 原样传出，安全
    #   · trap 体内**根本没有 exit**（只打印，如本仓 QA runner 的 `trap _early_stop ERR`）
    #     ⇒ bash 在 trap 返回后仍按原状态退出，rc 不变，安全
    has_exit = re.search(r"\bexit\b", trap_line)
    exit_const = re.search(r"\bexit\s+\d+\b", trap_line)
    refs_dollar = "$?" in trap_line or re.search(r"\$\{?[_A-Za-z]", trap_line)
    trap_changes_status = bool(has_exit) and (bool(exit_const) or not refs_dollar)
    trap_preserves_rc = not trap_changes_status
    has_set_e = bool(SET_E.search(text))
    captures = []
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("#"):
            continue
        if not RC_CAPTURE.search(line):
            continue
        prev = ""
        for j in range(i - 2, -1, -1):
            cand = lines[j].strip()
            if not cand or cand.startswith("#"):
                continue
            prev = cand
            break
        captures.append({
            "line": i,
            "text": line.strip()[:100],
            "prev": prev[:100],
            "guarded": bool(GUARDED.search(prev)) or "set +e" in prev,
        })
    return {
        "path": str(path.relative_to(REPO)) if str(path).startswith(str(REPO)) else str(path),
        "trap_err": has_trap_err,
        "trap_preserves_rc": trap_preserves_rc,
        "trap_line": trap_line.strip()[:140],
        "set_e": has_set_e,
        # ① 结构性：trap ERR + set -e ⇒ 本文件的 RC 采集全部不可信
        # 只有「trap ERR 且不传 rc 出去」+ set -e 才是结构性风险
        "structural_risk": has_trap_err and has_set_e and trap_changes_status,
        "captures": captures,
        "unguarded": [c for c in captures if not c["guarded"]],
    }


SELFTEST_BAD = "set -E\nset -e\ntrap 'exit 1' ERR\ngit diff --quiet x\nRC=$?\n"
SELFTEST_GOOD = "set -uo pipefail\nout=$(cmd)\nrc=$?\n"
SELFTEST_TRAP_OK = "set -euo pipefail\ntrap 'rc=$?; echo bad; exit $rc' ERR\ncmd\n"
SELFTEST_TRAP_PRINT = "set -euo pipefail\ntrap _early_stop ERR\ncmd\n"
SELFTEST_GUARDED = "set -e\nif git diff --quiet x; then rc=0; else rc=$?; fi\n"


def selftest(quiet: bool = False) -> int:
    """门自己的可失败用例：一个「永远返回绿」的实现过不了 SELFTEST_BAD。"""
    import tempfile
    cases = [
        ("trap ERR + set -e ⇒ 结构性风险", SELFTEST_BAD, True),
        ("set -e 下 if/else 采集 ⇒ 安全", SELFTEST_GUARDED, False),
        ("没有 set -e ⇒ 采集正确", SELFTEST_GOOD, False),
        ("trap 把 rc 原样传出去 ⇒ 安全", SELFTEST_TRAP_OK, False),
        ("trap 只打印不 exit ⇒ bash 仍按原状态退出，安全（本仓 QA runner 是这种）", SELFTEST_TRAP_PRINT, False),
    ]
    bad = []
    with tempfile.TemporaryDirectory() as td:
        for why, src, want_risk in cases:
            f = Path(td) / "case.sh"
            f.write_text(src)
            got = scan(f).get("structural_risk")
            if got != want_risk:
                bad.append(f"{why}: 期望 structural_risk={want_risk}，实际 {got}")
            elif not quiet:
                print(f"✓ selftest {why}")
    if bad:
        print("✗ 自检失败：", file=sys.stderr)
        for b in bad:
            print(f"    · {b}", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {len(cases)} 例全部符合预期（含 1 个必须红的负例）")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 本次没有读数（退出码 2）", file=sys.stderr)
        return 2

    files = [p for p in tracked_shell() if p.exists()]
    if not files:
        print("扫描域为空：git ls-files '*.sh' 没有结果 ⇒ 没有读数", file=sys.stderr)
        return 2
    rows = [r for r in (scan(p) for p in files) if r]
    bad = [r for r in rows if r["structural_risk"]]
    warn = [r for r in rows if r["unguarded"] and not r["structural_risk"]]

    if "--json" in sys.argv:
        print(json.dumps({"object": "git ls-files '*.sh'", "files": len(rows),
                          "structural_risk": bad,
                          "unguarded_reports": [{"path": r["path"], "captures": r["unguarded"]} for r in warn]},
                         ensure_ascii=False, indent=2))
        return 1 if bad else 0

    print(f"对象：git ls-files '*.sh' ⇒ {len(rows)} 个脚本")
    print(f"  trap … ERR **且把退出码换成常量** + set -e（结构性风险）：{len(bad)}")
    print(f"  rc=$? 未被 if/||/set +e 包裹（报告）：{len(warn)}")
    if bad:
        print("\n✗ 这些文件里 `RC=$?` 拿不到真实 rc（trap 会先退出）：", file=sys.stderr)
        for r in bad:
            print(f"    · {r['path']}", file=sys.stderr)
            print("      ⇒ 改成 `if cmd; then rc=0; else rc=$?; fi` 或 `cmd && rc=0 || rc=$?`", file=sys.stderr)
        return 1
    if warn:
        print("\n报告的条目（可能是有意的：没开 set -e 时 rc=$? 是正确的）：")
        for r in warn[:10]:
            for c in r["unguarded"][:3]:
                print(f"    · {r['path']}:{c['line']}  {c['text']}")
                print(f"        上一条：{c['prev']}")
    print("\ncheck  : 重跑本脚本；新增 `trap … ERR` 的文件会立刻出现在第一行计数里。")
    print("判据  : 每个防御都要有 must-fire 证明它和邻居合起来仍生效 —— 本脚本的 must-fire 是 --selftest。")
    print("口径  : 只有 `trap '<...> exit 1' ERR` 这类**把 rc 换成常量**的 trap 才是结构性风险；")
    print("        `exit $_rc`（原样传出）与「只打印不 exit」（bash 仍按原状态退出）都不算 ——")
    print("        本仓这 495 个脚本里两种正当写法都真实存在，粗口径会把它们全判红。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
