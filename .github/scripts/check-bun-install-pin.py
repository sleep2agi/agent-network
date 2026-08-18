#!/usr/bin/env python3
"""新增的 Dockerfile 不许再用未钉版本的 `bun.sh/install`。

背景(#728)
==========

`curl -fsSL https://bun.sh/install | bash` 装到什么版本**取决于构建那一刻上游是什么**。
同一个 commit 在不同时间构建,会跑在不同字节上 —— 而这类差异**只在出问题时才被发现**,
且第一反应永远是"代码变了吗",不是"bun 变了吗"。

仓里已经有做对的样板(`tests/test679-task-trace/Dockerfile`):

    ARG BUN_VERSION=1.3.14
    ARG BUN_LINUX_X64_SHA256=951ee2…
    RUN curl --fail … --retry 3 … "…/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \\
     && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun.zip" | sha256sum -c - …

🔴 这道门**不要求存量清零**,理由与 `check-home-path-baseline.py` 头注写的同一条
===========================================================================

实测(2026-08-18,origin/main):**38 个 Dockerfile 引用 `bun.sh/install`,其中只有 1 个钉了。**

一道要求"37 个全清"的门,会从第一天起就是红的;而**一道只因积压而红的门,等积压清完
就再也不会红,到时没人知道它还有没有效**。所以基线制:**今天这 37 个记在案,新增的才红。**

清理是欢迎的 —— 清掉一个就把它从基线里删掉,楼层只往下走、不会悄悄回填。

判据
====

对每个 tracked 的 Dockerfile(含 `Dockerfile.*` 变体):

  引用了 bun.sh/install  且  没有任何钉版本的证据  ⇒ 未钉

"钉版本的证据"任一即可(**故意写宽**:目的是挡"什么都没做",不是规定唯一写法):
  - `BUN_VERSION` / `BUN_INSTALL_VERSION` 之类的版本变量
  - `bun-v<数字>` 形式的下载 URL
  - `sha256`(校验和)

分母承重
========

🔴 扫到 0 个 Dockerfile,或基线文件读不到 ⇒ exit 2。
"没有新增违规"和"根本没扫到"必须长得不一样。

用法
====

    python3 .github/scripts/check-bun-install-pin.py
    python3 .github/scripts/check-bun-install-pin.py --selftest
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

BASELINE = "docs/bun-install-pin-baseline.txt"

USES_INSTALLER = re.compile(r"bun\.sh/install")
PINNED_HINTS = (
    re.compile(r"BUN_VERSION|BUN_INSTALL_VERSION"),
    re.compile(r"bun-v[0-9]"),
    re.compile(r"(?i)sha256"),
)


def is_dockerfile(path: str) -> bool:
    name = Path(path).name
    return name == "Dockerfile" or name.startswith("Dockerfile.")


def is_pinned(text: str) -> bool:
    return any(p.search(text) for p in PINNED_HINTS)


def uses_installer(text: str) -> bool:
    return bool(USES_INSTALLER.search(text))


def unpinned(text: str) -> bool:
    return uses_installer(text) and not is_pinned(text)


def selftest() -> int:
    cases = []

    def ck(name, text, want):
        got = unpinned(text)
        cases.append((name, got == want, f"got={got} want={want}"))

    ck("裸装 → 未钉", "RUN curl -fsSL https://bun.sh/install | bash", True)
    ck("带 BUN_VERSION → 已钉", "ARG BUN_VERSION=1.3.14\nRUN curl https://bun.sh/install | bash", False)
    ck("带 sha256 → 已钉", "RUN curl https://bun.sh/install | bash && sha256sum -c -", False)
    ck("下载 URL 带 bun-v → 已钉", "RUN curl .../bun-v1.3.14/bun-linux-x64.zip", False)
    # 🔴 负向:压根不装 bun 的 Dockerfile 不该被这道门碰到
    ck("不引用安装器 → 不判", "FROM node:22\nRUN npm ci", False)
    ck("只提到 bun 这个词 → 不判", "# bun is faster\nFROM node:22", False)

    for n, ok, d in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}   [{d}]")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=True).stdout.strip())
    tracked = subprocess.run(["git", "ls-files", "-z"], cwd=repo,
                             capture_output=True, text=True, check=True).stdout.split("\0")
    dockerfiles = sorted(p for p in tracked if p and is_dockerfile(p))
    if not dockerfiles:
        print("FAIL: 一个 Dockerfile 都没扫到 —— 取集塌了,拒绝通过", file=sys.stderr)
        return 2

    base_path = repo / BASELINE
    if not base_path.is_file():
        print(f"FAIL: 读不到基线 {BASELINE} —— 拒绝通过", file=sys.stderr)
        return 2
    known = {ln.strip() for ln in base_path.read_text(encoding="utf-8").split("\n")
             if ln.strip() and not ln.startswith("#")}

    current = set()
    for f in dockerfiles:
        try:
            text = (repo / f).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if unpinned(text):
            current.add(f)

    new = sorted(current - known)
    fixed = sorted(known - current)

    print(f"scanned {len(dockerfiles)} tracked Dockerfile(s); "
          f"{len(current)} still install bun unpinned; baseline lists {len(known)}")
    if fixed:
        print(f"note: {len(fixed)} file(s) got pinned — 把它们从 {BASELINE} 里删掉,楼层只往下走:")
        for f in fixed:
            print(f"  - {f}")
    if new:
        for f in new:
            print(f"::error file={f}::新增了未钉版本的 `bun.sh/install`。"
                  f"照 tests/test679-task-trace/Dockerfile 的样板钉 BUN_VERSION + sha256。")
        print(f"\n{len(new)} new unpinned file(s).")
        return 1
    print("no new unpinned bun installer.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
