#!/usr/bin/env python3
"""`?token=` 的接受点只许减少,不许增加。

## 背景

`server/src/server.ts` 的 auth helper 默认**接受 URL 查询串里的 token**:

    function requestToken(req, options = {}) {
      const header = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (options.allowQueryToken === false) return header || "";   // ← 只有显式关才关
      return header || url.searchParams.get("token") || "";         // ← 默认接受
    }

query 里的凭据会进**访问日志**和 **Referer**(#501)。而这个开关是**逐调用点 opt-out** 的:
默认值决定了未来新增的调用点是安全还是不安全,**而新增调用点的人不会收到任何提示。**

把默认翻成拒绝是正确的方向,但那是一次会影响 SSE / 下载链接等真实路径的行为改动,
需要单独评估。**这道门不改行为,只保证这件事不再变糟。**

## 判据(三条棘轮)

1. **绕过 helper 直接读 `searchParams.get("token")` 的行数 ≤ 基线** —— 只许减少;
2. **helper 内部那一处必须恰好是 1 处** —— 变 0 说明 helper 被改写了(可能是好事,但要人确认);
   变 2 说明有人复制了一份。
3. **显式 `allowQueryToken: false` 的调用点数 ≥ 基线** —— **不许有人把已有的保护摘掉**。

## 这道门不管什么

不判断某个具体端点该不该接受 query token(那要看它有没有别的办法带凭据),
也不改任何行为。**它只保证:今天的数字是上限,不是起点。**

    python3 .github/scripts/check-query-token-ratchet.py
    python3 .github/scripts/check-query-token-ratchet.py --selftest
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SRC_DIR = Path("server/src")

# 2026-08-18 实测基线。要改必须在 PR 里说明是哪一条被消掉/新增了。
BYPASS_BASELINE = 11      # 绕过 helper 直接读 query token 的行
OPTOUT_FLOOR = 2          # 显式 `allowQueryToken: false` 的**调用点**数
# 🔴 我第一版写 3,是自己 grep 时把 helper 内部那句 `options.allowQueryToken === false`
#    也数了进去 —— 那不是调用点(而且没有冒号,正则本来也不该匹配)。
#    是这道门在真源码上跑出 `2 < floor 3` 才把我的错基线顶出来的。

QUERY_TOKEN = re.compile(r'searchParams\.get\(\s*["\']token["\']\s*\)')
HELPER_DEF = re.compile(r'^\s*function\s+requestToken\s*\(', re.M)
OPTOUT = re.compile(r'allowQueryToken\s*:\s*false')


def helper_span(text: str) -> tuple[int, int] | None:
    """requestToken 函数体的行号区间(1-based, 闭区间)。"""
    m = HELPER_DEF.search(text)
    if not m:
        return None
    start = text.count("\n", 0, m.start()) + 1
    lines = text.split("\n")
    depth = 0
    for i in range(start - 1, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if depth == 0 and i > start - 1:
            return (start, i + 1)
    return (start, len(lines))


def analyse(files: dict[str, str]) -> tuple[int, int, int]:
    """→ (helper 内部命中数, 绕过 helper 的命中数, opt-out 处数)"""
    inside = bypass = optout = 0
    for name, text in files.items():
        span = helper_span(text) if name.endswith("server.ts") else None
        for lineno, line in enumerate(text.split("\n"), start=1):
            if QUERY_TOKEN.search(line):
                if span and span[0] <= lineno <= span[1]:
                    inside += 1
                else:
                    bypass += 1
            optout += len(OPTOUT.findall(line))
    return inside, bypass, optout


def read_sources() -> dict[str, str]:
    if not SRC_DIR.is_dir():
        return {}
    return {
        str(p): p.read_text(encoding="utf-8", errors="replace")
        for p in sorted(SRC_DIR.glob("*.ts"))
        if not p.name.endswith(".test.ts")
    }


def run() -> int:
    files = read_sources()
    if not files:
        print(f"::error::no non-test .ts under {SRC_DIR} — scope regression, refusing to pass",
              file=sys.stderr)
        return 2
    inside, bypass, optout = analyse(files)
    print(f"scanned {len(files)} file(s); query-token reads: inside_helper={inside} "
          f"bypassing_helper={bypass} (baseline {BYPASS_BASELINE}); "
          f"explicit allowQueryToken:false = {optout} (floor {OPTOUT_FLOOR})")

    problems = 0
    if inside != 1:
        print(f"::error::expected exactly 1 query-token read inside requestToken(), found {inside}. "
              f"0 means the helper was rewritten (possibly good — say so in the PR and update this "
              f"gate); >1 means someone duplicated it.")
        problems += 1
    if bypass > BYPASS_BASELINE:
        print(f"::error::{bypass} call sites read `?token=` directly, above the baseline of "
              f"{BYPASS_BASELINE}. Credentials in the query string reach access logs and Referer "
              f"(#501). Route the new one through requestToken() — and pass "
              f"`allowQueryToken: false` unless the endpoint genuinely cannot carry a header.")
        problems += 1
    if optout < OPTOUT_FLOOR:
        print(f"::error::only {optout} call site(s) pass `allowQueryToken: false`, below the floor "
              f"of {OPTOUT_FLOOR} — an existing protection was removed.")
        problems += 1

    if problems:
        print(f"\n{problems} problem(s).")
        return 1
    print("query-token surface did not grow; existing opt-outs are intact.")
    return 0


# --- selftest ---------------------------------------------------------------
# 夹具用字符串拼接构造,避免这个文件被自己的正则扫到。
def selftest() -> int:
    GET = 'searchParams.get(' + '"token"' + ')'
    OPT = 'allowQueryToken' + ': false'
    HELPER = (
        "function requestToken(req, options = {}) {\n"
        "  const header = req.headers.get('Authorization');\n"
        f"  return header || url.{GET} || '';\n"
        "}\n"
    )
    cases = []

    def check(name, body, want):
        got = analyse({"server/src/server.ts": body})
        cases.append((name, got == want, f"got={got} want={want}"))

    check("干净基准:helper 内 1 处,无绕过,无 opt-out",
          HELPER, (1, 0, 0))
    check("🔴 新增一个绕过点 → bypass 计数 +1",
          HELPER + f"const t = url.{GET};\n", (1, 1, 0))
    check("opt-out 被数到",
          HELPER + f"requireAuth(req, {{ {OPT} }});\n", (1, 0, 1))
    check("🔴 helper 里那处被删 → inside=0（上游报错)",
          "function requestToken(req) {\n  return req.headers.get('Authorization');\n}\n", (0, 0, 0))
    # 复制一份 helper 出来:副本里的那次读取**就是一次绕过**(它不在 requestToken 体内),
    # 所以正确期望是 inside=1 / bypass=1。我第一版把它写成 (2,0,0),被 selftest 顶红了 ——
    # 错的是我的期望,不是实现。
    check("helper 被复制一份 → 副本算绕过(inside=1, bypass=1)",
          HELPER.replace("requestToken", "requestTokenCopy") + HELPER, (1, 1, 0))
    check("多行 helper 体也能正确圈定范围",
          "function requestToken(req, options = {}) {\n  if (a) {\n    return b;\n  }\n"
          f"  return url.{GET};\n}}\n" + f"const outside = url.{GET};\n", (1, 1, 0))

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}   [{detail}]")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else run())
