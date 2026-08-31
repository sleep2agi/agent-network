#!/usr/bin/env python3
"""直接把 hub 的无时区时间戳喂给 `new Date(` / `Date.parse(` 的地方只许减少。

## 背景

hub 的 SQLite 列走 `datetime('now')` —— **UTC，但不带时区标记**（`2026-08-31 09:12:00`）。
`new Date(s)` / `Date.parse(s)` 遇到这种串会按**本机时区**解析，误差 = 主机偏移，
而且**不报错**。#1650 一次点出 5 处，其中一处的后果是：

    TZ=America/*  →  ts 偏晚  →  `fresh = ts >= restartStartedAt` **恒 true**
                                 「重启后心跳有没有刷新」这道校验被静默放行

五处已全部改为走 `server/src/hub-timestamp.ts` 的 `parseHubTimestamp()`（显式补 `Z`）。

## 🔴 为什么这一类**必须**用扫描门兜，而不是靠测试

`bun test` 把测试进程的时区固定成 UTC。在 UTC 下，「按 UTC 解析」和「按本地解析」
**得到同一个数** —— 也就是说这一整类缺陷在测试进程里**结构上不可见**。
#1649 实测：把新模块里补 `Z` 的那一步去掉，**11 条针对性测试全绿**，
只有变异见证才发现了它。

⇒ 不是「大家忘了写测试」，是「**写了也照样绿**」。

## 判据（两条棘轮）

1. **生产代码里 `new Date(x_at)` / `Date.parse(x_at)` 的处数 ≤ 基线** —— 只许减少。
2. **`parseHubTimestamp(` 的调用点数 ≥ 下限** —— 不许有人把已有的保护摘掉
   （把一处改回裸 `new Date` 会同时压低这个数，两条判据从相反方向夹住）。

## 这道门不管什么

不判断某一处**是不是**真缺陷。当前基线里的 4 处逐一核过，**没有一处是 #1650 那一类**：

| 位置 | 为什么安全 |
|---|---|
| `agent-node/src/goals/self-loop-tools.ts` `g.updated_at` | 本地 goal store 写的是 `toISOString()`，带 `Z` |
| `server/src/scheduled-tasks.ts` `spec.run_at` | 来自同文件 `iso(when)`，恒带 `Z` |
| `server/src/scheduled-tasks.ts` `row.next_run_at` | zod `datetime({ offset: true })`，带偏移 |
| `server/src/scheduled-tasks.ts` `obj.run_at` | 调用方传的 API 入参，**不是 hub 的 TEXT 列**（另一类问题） |

#1650 当时把这道门排在后面，理由是「10 处命中里 5 处真缺陷 ⇒ 50% 误报，
一道会产生 50% 误报的门大概率第一周就被关掉」—— **那个判断当时是对的**。
五处修完后重新量：**生产命中 4 处，这一类的真缺陷 0 处**，误报率 0%。
它说的「先量再定」，量出来的结论变了。

    python3 .github/scripts/check-hub-timestamp-ratchet.py
    python3 .github/scripts/check-hub-timestamp-ratchet.py --selftest
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# 🔴 rglob，不是 glob。同仓 check-query-token-ratchet.py 记着的教训：
#    棘轮的输出是一个**数**，一个写在子目录里的新命中不会把数抬高 ——
#    它根本不在分母里，打印出来的和真绿逐字相同。
SRC_DIRS = [
    Path("server/src"),
    Path("agent-network/bin"),
    Path("agent-network/src"),
    Path("agent-node/src"),
]

# 2026-08-31 实测基线。要改必须在 PR 里说明是哪一条被消掉/新增了。
RAW_BASELINE = 4      # 生产代码里裸解析 *_at 的处数
GUARD_FLOOR = 9       # parseHubTimestamp( 的调用点数

# `new Date(<arg>)` / `Date.parse(<arg>)`，且 <arg> 里出现 `_at`。
RAW_PARSE = re.compile(r'(?:new\s+Date|Date\.parse)\(\s*([A-Za-z_$][\w$.?\[\]"\']*)')
AT_FIELD = re.compile(r'_at\b|_at[?\]"\']')
GUARD = re.compile(r'parseHubTimestamp\s*\(')


def analyse(files: dict[str, str]) -> tuple[int, int, list[str]]:
    """→ (裸解析处数, guard 调用点数, 命中明细)"""
    raw = guard = 0
    hits: list[str] = []
    for name, text in files.items():
        for lineno, line in enumerate(text.split("\n"), start=1):
            for m in RAW_PARSE.finditer(line):
                if AT_FIELD.search(m.group(1)):
                    raw += 1
                    hits.append(f"{name}:{lineno}  {line.strip()[:88]}")
            guard += len(GUARD.findall(line))
    return raw, guard, hits


def read_sources() -> dict[str, str]:
    out: dict[str, str] = {}
    for d in SRC_DIRS:
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*.ts")):
            if p.name.endswith(".test.ts"):
                continue
            out[str(p)] = p.read_text(encoding="utf-8", errors="replace")
    return out


def run() -> int:
    files = read_sources()
    if not files:
        print("::error::no non-test .ts under " + ", ".join(str(d) for d in SRC_DIRS)
              + " — scope regression, refusing to pass", file=sys.stderr)
        return 2
    raw, guard, hits = analyse(files)
    print(f"scanned {len(files)} file(s); raw *_at parses: {raw} (baseline {RAW_BASELINE}); "
          f"parseHubTimestamp() call sites: {guard} (floor {GUARD_FLOOR})")
    for h in hits:
        print(f"  {h}")

    problems = 0
    if raw > RAW_BASELINE:
        print(f"::error::{raw} site(s) hand a *_at value straight to new Date()/Date.parse(), "
              f"above the baseline of {RAW_BASELINE}. hub's TEXT columns are UTC WITHOUT a zone "
              f"marker, so those parse as LOCAL time — the error equals the host offset and "
              f"nothing throws. Route it through parseHubTimestamp() "
              f"(server/src/hub-timestamp.ts). If the value provably carries a zone, say which "
              f"line proves it in the PR and raise the baseline. #1650")
        problems += 1
    if guard < GUARD_FLOOR:
        print(f"::error::only {guard} parseHubTimestamp() call site(s), below the floor of "
              f"{GUARD_FLOOR} — an existing protection was removed. #1650")
        problems += 1

    if problems:
        print(f"\n{problems} problem(s).")
        return 1
    print("hub-timestamp surface did not grow; existing parseHubTimestamp() guards are intact.")
    return 0


# --- selftest ---------------------------------------------------------------
# 🔴 两层分开自检：**判据**（给它一行，看它报不报）和**取集**（造一棵目录树，
#    看「该收的收进来了没有」）。同仓实测过：把 rglob 退回 glob，取集自检红，
#    而判据自检 18/18 仍然全绿 —— 它们测的不是同一件事。
def selftest() -> int:
    ok = 0
    fail = 0

    def ck(name: str, cond: bool) -> None:
        nonlocal ok, fail
        if cond:
            ok += 1
        else:
            fail += 1
            print(f"  selftest FAIL: {name}")

    # 夹具用字符串拼接，避免这个文件被自己的正则扫到。
    ND = "new " + "Date("
    DP = "Date." + "parse("
    PH = "parseHubTimestamp" + "("

    def one(line: str) -> tuple[int, int]:
        r, g, _ = analyse({"x.ts": line})
        return r, g

    # ── 判据层 ──
    ck("new Date(row.created_at) 命中", one(f"const a = {ND}row.created_at);")[0] == 1)
    ck("Date.parse(g.updated_at) 命中", one(f"const a = {DP}g.updated_at);")[0] == 1)
    ck("可选链 row?.last_seen_at 命中", one(f"const a = {ND}row?.last_seen_at);")[0] == 1)
    ck("方括号 row['expires_at'] 命中", one(f"const a = {ND}row['expires_at']);")[0] == 1)
    ck("同一行两处各算一次", one(f"{ND}a.created_at); {ND}b.updated_at);")[0] == 2)
    # 反例：不含 _at 的参数不该命中，否则这道门会把所有 new Date() 都扫进来
    ck("new Date(now) 不命中", one(f"const a = {ND}now);")[0] == 0)
    ck("new Date(ms + 1000) 不命中", one(f"const a = {ND}ms);")[0] == 0)
    ck("裸 new Date() 不命中", one(f"const a = {ND});")[0] == 0)
    # 🔴 朝**正确**方向变异也要验：走了 guard 的写法不该被算成裸解析
    ck("parseHubTimestamp(row.created_at) 不算裸解析",
       one(f"const a = {PH}row.created_at);")[0] == 0)
    ck("parseHubTimestamp 计入 guard 数", one(f"const a = {PH}row.created_at);")[1] == 1)
    ck("裸解析不计入 guard 数", one(f"const a = {ND}row.created_at);")[1] == 0)
    # `_at` 必须是词尾/边界，`_atom` 不算
    ck("_atom 不误命中", one(f"const a = {ND}cfg._atom);")[0] == 0)

    # ── 取集层 ──（判据全对也可能扫不到文件）
    import tempfile, os
    with tempfile.TemporaryDirectory() as td:
        cwd = os.getcwd()
        try:
            os.chdir(td)
            for rel in [
                "server/src/a.ts",              # 顶层
                "server/src/deep/nested/b.ts",  # 🔴 子目录 —— glob 会漏，rglob 不漏
                "agent-node/src/c.ts",
                "server/src/d.test.ts",         # 测试，应排除
                "server/src/e.md",              # 非 .ts，应排除
                "docs/f.ts",                    # 不在 SRC_DIRS，应排除
            ]:
                p = Path(rel)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(f"const a = {ND}row.created_at);\n", encoding="utf-8")
            got = read_sources()
            ck("取集：收了顶层文件", "server/src/a.ts" in got)
            ck("取集：收了子目录文件（rglob 而非 glob）", "server/src/deep/nested/b.ts" in got)
            ck("取集：收了第二个根目录", "agent-node/src/c.ts" in got)
            ck("取集：排除 .test.ts", "server/src/d.test.ts" not in got)
            ck("取集：排除非 .ts", "server/src/e.md" not in got)
            ck("取集：排除 SRC_DIRS 之外", "docs/f.ts" not in got)
            ck("取集：分母正好 3", len(got) == 3)
            raw, _, _ = analyse(got)
            ck("取集+判据：3 个文件各 1 处 = 3", raw == 3)
        finally:
            os.chdir(cwd)

    print(f"selftest: {ok}/{ok + fail} ok")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(run())
