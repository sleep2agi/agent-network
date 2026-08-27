#!/usr/bin/env python3
"""禁止用 `existsSync(/proc/<pid>)` 断言「这一代进程没了」。

## 为什么

#1315:SIGTERM 之后、父进程 reap 之前,进程处于 `Z`(僵尸),**`/proc/<pid>` 条目仍在**。
而产品侧 `sameProcessGenerationExists` 把 `Z`/`X` 当作「已消失」——
于是「产品认为它没了」和「/proc 目录还在」同时成立。

拿 `existsSync(/proc/<pid>)).toBe(false)` 去断言回收,在**空闲机器上几乎总是绿**
(reap 很快),在**忙碌机器上间歇红**。实测 31 次执行里 1 次。
它红的时候看起来像产品缺陷,其实是判据和产品契约不一致。

正确写法:`processGenerationGone(pid, startTime)` / `waitGenerationGone(...)`。

## 🔴 只禁 `.toBe(false)` 方向,不禁 `.toBe(true)`

同一个调用,相反的语义:
    toBe(true)   = 「它还没被杀」—— 合法,而且 leader-lifecycle.test.ts 里那颗
                   zombie 钉子**故意**断 `/proc` 仍在。一次全局替换会把它改反。
    toBe(false)  = 「这一代没了」—— 就是本门要禁的。
13 处里只有 4 处是后者。**这就是为什么它必须是精确形态匹配,而不是"提到 /proc 就报"。**

## 基线

2026-08-28 全仓 766 个源文件实测:`existsSync(/proc` 出现在 3 个文件,
`.toBe(false)` 形态 **0 处**。分母是 0 ⇒ 新增一处就红,没有存量豁免要维护。
"""
import re
import subprocess
import sys
from pathlib import Path

# 形态:existsSync(...proc/...)  之后一到两行内出现 .toBe(false)
EXISTS = re.compile(r"existsSync\s*\([^)]*?/proc/")
FALSY = re.compile(r"\.toBe\(\s*false\s*\)|\.toBeFalsy\(\)")
SRC = (".ts", ".mts", ".tsx", ".js", ".mjs", ".cjs")


def collect(repo: Path) -> list[Path]:
    """取集:git 跟踪的全部源文件。

    🔴 用 `git ls-files` 而不是 rglob:后者会扫进 node_modules / dist / .worktrees,
       分母虚高几万,而且会把第三方代码算成违规。
    🔴 但 `git ls-files` 看不见**未跟踪的新文件** —— 本地跑这道门之前要先 `git add`。
       CI 上无所谓(checkout 出来的都是跟踪的)。
    """
    out = subprocess.run(["git", "-C", str(repo), "ls-files"],
                         capture_output=True, text=True, check=True).stdout
    return [repo / p for p in out.split("\n")
            if p.endswith(SRC) and "node_modules/" not in p]


def scan_text(text: str) -> list[int]:
    lines = text.split("\n")
    bad = []
    for i, line in enumerate(lines):
        if not EXISTS.search(line):
            continue
        window = " ".join(lines[i:i + 2])
        if FALSY.search(window):
            bad.append(i + 1)
    return bad


def selftest() -> int:
    cases = [
        ("expect(existsSync(`/proc/${pid}`)).toBe(false);", [1], "同行 toBe(false)"),
        ("expect(existsSync(`/proc/${pid}`))\n  .toBe(false);", [1], "跨行 toBe(false)"),
        ("expect(existsSync(`/proc/${pid}`)).toBeFalsy();", [1], "toBeFalsy"),
        ("expect(existsSync(`/proc/${pid}`)).toBe(true);", [], "🔴 toBe(true) 必须放行(zombie 钉子)"),
        ("expect(await processGenerationGone(pid, st)).toBe(false);", [], "正确写法不该被误报"),
        ("expect(existsSync(sockPath)).toBe(false);", [], "非 /proc 路径不管"),
        ("const raw = readFileSync(`/proc/${pid}/stat`);", [], "读 stat 不是断言"),
    ]
    bad = 0
    for text, want, label in cases:
        got = scan_text(text)
        ok = got == want
        print(f"  {'PASS' if ok else 'FAIL'}  {label}  期望={want} 实际={got}")
        bad += 0 if ok else 1
    # 取集自检:造一棵目录树,确认递归 + 后缀都收得到
    print(f"  判据自检: {len(cases) - bad}/{len(cases)}")
    return 1 if bad else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    repo = Path(sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else ".").resolve()
    files = collect(repo)
    findings = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for n in scan_text(text):
            findings.append(f"  🔴 {f.relative_to(repo)}:{n}  用 existsSync(/proc/<pid>) 断言「进程没了」")
    for line in findings:
        print(line)
    print(f"PROC-GONE: {'RED' if findings else 'OK'}（扫了 {len(files)} 个源文件，违规 {len(findings)} 处）")
    if findings:
        print("  改法：processGenerationGone(pid, startTime) / waitGenerationGone(...) —— 见 #1315。")
        print("  🔴 只禁 .toBe(false) 方向；.toBe(true)（『它还没被杀』）是合法的，本门不碰。")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
