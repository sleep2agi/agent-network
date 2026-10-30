#!/usr/bin/env python3
"""REST 端点的**静态**清单 —— 给 #3214 造分母的第一步（并如实标出它看得见/看不见什么）。

2026-10-31 —— 为什么需要它：

    MCP 侧有注册表（server.tool(...)）⇒ 分母 = 88，覆盖率有意义
    REST 侧是手写 `url.pathname` 匹配 ⇒ 分母不可数 ⇒ 覆盖率只能是 0/0
    ⇒ 而 0/0 在报表里会被写成「无违规」或「N/A」

这份脚本**不是**那个分母（真正的分母要抽路由表），但它能把「今天散落的手写匹配」
列成一份可读清单，让「还差多少」这件事第一次有形状。

它看得见（以 server.ts 为对象）：
    · `url.pathname === "/x"` / `!== "/x"`
    · `url.pathname.startsWith("/x")`
    · `url.pathname.match(/^\\/x/)` 的**字面前缀**（只取 pattern 里的静态前缀）

它看不见（所以这不是分母）：
    · 由变量拼出来的路径、正则里的动态段、位于其它文件里的匹配
    · 中间件与兜底（`app.all` 之类）的真实覆盖顺序

用法：python3 scripts/report-rest-endpoints.py [--json]
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGET = REPO / "server" / "src" / "server.ts"

PATTERNS = (
    ("eq", re.compile(r'url\.pathname\s*===\s*"([^"]+)"')),
    ("eq_neg", re.compile(r'url\.pathname\s*!==\s*"([^"]+)"')),
    ("starts_with", re.compile(r'url\.pathname\.startsWith\(\s*"([^"]+)"')),
    ("regex_prefix", re.compile(r'url\.pathname\.match\(\s*/\^\\/([^/\\$?(]+)')),
)


def _provenance() -> list[str]:
    """2026-10-31 —— 让「手抄的清单」无法冒充「生成的清单」。

    分母非零只是必要条件：一份**手写的、与代码不同步**的清单同样非零，而它仍然错。
    ⇒ 完成判据是「从代码生成 + 一条命令能重跑 + 重跑后不变」。
    这三件事里，只有第一件能被贴在一行文本里：
        generated_from: <扫描根> @ <ref>[+dirty]
    手抄的清单产不出这一行，因为它没有 ref。

    reproduce 是第二件（命令）。第三件（重跑不变）由人跑两次比对 —— 但至少这一行让比对有对象。
    """
    import subprocess
    def git(*args: str) -> str:
        try:
            return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            return ""
    ref = git("rev-parse", "--short", "HEAD") or "unknown"
    dirty = git("status", "--porcelain")
    # ⚠️ 只报「相对本文件」的 dirty：整棵树的 dirty 会让这一行在无关改动下天天变，
    #    于是读者学会忽略它（一个天天变的字段等于没有字段）。
    try:
        local_dirty = subprocess.run(["git", "status", "--porcelain", str(TARGET.relative_to(REPO))],
                                     cwd=REPO, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        local_dirty = ""
    state = "+dirty" if local_dirty else ""
    return [
        f"> generated_from: `{TARGET.relative_to(REPO)}` @ `{ref}{state}`",
        f"> reproduce: `python3 scripts/report-rest-endpoints.py --markdown`",
        "> 重跑后与本文档不一致 ⇒ 本文档过期（它没有经过这一行的生成器就进来了）",
    ]


def main() -> int:
    if not TARGET.exists():
        print(f"✗ 找不到 {TARGET}", file=sys.stderr)
        return 2
    text = TARGET.read_text(encoding="utf-8", errors="replace")

    found: dict[str, set[str]] = {}
    # 2026-10-31 —— 每条匹配都要带**行号**：路由表的下一个使用者是「抽表」，
    # 而抽表必须知道每一条在源码哪里（否则改完对不上账）。同时保留**重复**：
    # 同一个路径在两处被匹配，是抽表时最容易漏的一类。
    entries: list[dict] = []
    for kind, pat in PATTERNS:
        for m in pat.finditer(text):
            found.setdefault(kind, set()).add(m.group(1))
            lineno = text.count("\n", 0, m.start()) + 1
            line_text = text.splitlines()[lineno - 1].strip() if lineno - 1 < len(text.splitlines()) else ""
            entries.append({"path": m.group(1), "kind": kind, "line": lineno, "text": line_text[:120]})
    entries.sort(key=lambda e: (e["line"], e["kind"], e["path"]))

    total = sum(len(v) for v in found.values())
    if "--markdown" in sys.argv:
        rows = []
        for kind, _ in PATTERNS:
            for v in sorted(found.get(kind, ())):
                rows.append((v, kind))
        for line in _provenance():
            print(line)
        print()
        print("| path | 匹配形态 | 源码行 |")
        print("|---|---|---|")
        for e in entries:
            print(f"| `{e['path']}` | {e['kind']} | :{e['line']} |")
        print()
        dup = len(entries) - len({(e["path"], e["kind"]) for e in entries})
        print(f"共 {len(entries)} 条匹配（去重后 {len(rows)} 条 path+形态；重复 {dup} 条）")
        print("（对象：server/src/server.ts；生成于本脚本，**不要手改**）")
        return 0

    if "--json" in sys.argv:
        print(json.dumps({
            "object": "server/src/server.ts",
            "by_kind": {k: sorted(v) for k, v in found.items()},
            "total": total,
            "entries": entries,
            "provenance": [l.lstrip("> ") for l in _provenance()],
            "not_a_denominator_because": [
                "variable-built paths are invisible",
                "dynamic segments inside regexes are cut at the first variable char",
                "matches living in other files are not scanned",
                "middleware/fallback ordering is not modelled",
            ],
        }, ensure_ascii=False, indent=1))
        return 0

    print("对象        : server/src/server.ts（**只是这一个文件**，不是整个 REST 面）")
    print(f"匹配点合计  : {total}")
    for kind, _ in PATTERNS:
        vals = sorted(found.get(kind, ()))
        if not vals:
            continue
        print(f"\n[{kind}] {len(vals)} 处")
        for v in vals[:40]:
            print(f"    {v}")
        if len(vals) > 40:
            print(f"    …（共 {len(vals)} 处）")

    prefixes = Counter()
    for vals in found.values():
        for v in vals:
            seg = v.strip("/").split("/")[0]
            prefixes[seg] += 1
    print("\n按首段分布（用来估「一张路由表大概要写多少条」）：")
    for seg, n in prefixes.most_common(12):
        print(f"    {seg or '(root)':20s} {n}")

    print("\n⚠️ 这不是分母：")
    print("    · 变量拼出来的路径看不见")
    print("    · 正则里的动态段被截到第一个变量字符")
    print("    · 其它文件里的匹配没扫")
    print("    · 中间件与兜底的覆盖顺序没有建模")
    print("⇒ 它能回答「散落的手写匹配大概有多少」，不能回答「一共有多少个端点」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
