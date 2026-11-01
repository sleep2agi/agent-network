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
    """2026-10-31 —— 生成物的归属要按**内容**，不按提交。

    第一版写的是 `generated_from: <file> @ <ref>`。它有两个问题：
      ① 每提交一次（哪怕没改这个文件）它就过期 ⇒ 一个天天变红的检查会被学会忽略；
      ② 它回答的是「我在哪个提交生成」，而读者真正要问的是「我手里的这份对不对应当前源码」。

    ⇒ 改成 source_sha256（前 12 位）。它只在**源码变了**的时候变。
    手抄的清单产不出这一行（它没有 sha）。
    """
    import hashlib
    try:
        sha = hashlib.sha256(TARGET.read_bytes()).hexdigest()[:12]
    except OSError:
        sha = "unreadable"
    return [
        f"> generated_from: `{TARGET.relative_to(REPO)}` source_sha256=`{sha}`",
        "> reproduce: `python3 scripts/report-rest-endpoints.py --table-json`（或 --markdown）",
        "> 机器可读版本（表草稿，尚未被任何代码消费）：`docs/rest-route-table.json`",
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
            # 2026-10-31 —— 路由表的**主键不是 path**。
            # 实测：8 个多处 path 里 6 个是「同一 path、不同 method」或「同一 path、不同 query 判别」，
            # 而 /api/messages 的 `?scope=user` 分支**必须排在**通用分支之前（顺序承载语义）。
            # ⇒ 这里把 method 与 query 判别一起抽出来，作为「这一条到底识别什么」的部分键。
            meth = re.search(r'req\.method\s*===\s*"([A-Z]+)"', line_text)
            qkeys = re.findall(r'searchParams\.get\("([^"]+)"\)', line_text)
            entries.append({
                "path": m.group(1), "kind": kind, "line": lineno, "text": line_text[:120],
                "method": meth.group(1) if meth else None,
                "query": qkeys,
            })
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
        print("| 序 | path | method | query 判别 | 匹配形态 | 源码行 |")
        print("|---|---|---|---|---|---|")
        for i, e in enumerate(entries, 1):
            print(f"| {i} | `{e['path']}` | {e.get('method') or '—'} | "
                  f"{','.join(e.get('query') or []) or '—'} | {e['kind']} | :{e['line']} |")
        print()
        dup = len(entries) - len({(e["path"], e["kind"]) for e in entries})
        print(f"共 {len(entries)} 条匹配（去重后 {len(rows)} 条 path+形态；重复 {dup} 条）")
        print("（对象：server/src/server.ts；生成于本脚本，**不要手改**）")
        # 2026-10-31 —— 抽表前的第三格：**按 path 分组**。
        # 抽表不能「一条一条搬」：同一个 path 出现在多处时，搬漏一处就是行为改变。
        from collections import defaultdict as _dd
        groups: dict[str, list[dict]] = _dd(list)
        for e in entries:
            groups[e["path"]].append(e)
        multi = {k: v for k, v in groups.items() if len(v) > 1}
        print()
        print(f"按 path 分组：{len(groups)} 个不同 path，其中 **{len(multi)} 个出现在多处**"
              f"（共 {sum(len(v) for v in multi.values())} 条匹配）")
        print()
        print("| path | 处数 | 各处行号 | 判别键（method / query） | 形态是否一致 |")
        print("|---|---|---|---|---|")
        for path, items in sorted(multi.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            kinds = {i["kind"] for i in items}
            keys = []
            for i in items:
                k = (i.get("method") or "-") + ("?" + ",".join(i.get("query") or []) if i.get("query") else "")
                keys.append(f"{k}@:{i['line']}")
            print(f"| `{path}` | {len(items)} | {', '.join(':' + str(i['line']) for i in items)} "
                  f"| {' ｜ '.join(keys)} | {'是' if len(kinds) == 1 else '否（' + '/'.join(sorted(kinds)) + '）'} |")
        print()
        # 「同一 path、不同判别键」= 抽表时必须把它们当成**不同的行**，且保持原顺序。
        split_by_key = [k for k, v in multi.items()
                        if len({(i.get("method"), tuple(i.get("query") or [])) for i in v}) > 1]
        print(f"⇒ 同一 path 下**判别键不同**（method/query）的有 {len(split_by_key)} 个："
              f"{', '.join('`' + k + '`' for k in sorted(split_by_key))}")
        print("   抽表时它们是**不同的行**，且顺序承载语义（更具体的判别必须在前）——")
        print("   按 path 做键会把它们合并成一行，而合并后行为改变、测试未必红。")
        mixed = [k for k, v in multi.items() if len({i["kind"] for i in v}) > 1]
        if mixed:
            print(f"⇒ 「形态不一致」的有 {len(mixed)} 组（{', '.join('`' + m + '`' for m in mixed[:5])}）："
                  f"抽表时最容易改坏 —— 搬进表里必须保持它们的先后与形态。")
        else:
            print("⇒ 本日**没有**形态不一致的分组（0 组）—— 所以这一格今天不构成风险；"
                  "但它必须留在输出里：下次出现时，读者才知道该看哪一栏。")
        return 0

    if "--table-json" in sys.argv:
        # 2026-10-31 —— 「表该长什么样」先落成**数据**，再由下一轮的路由重构去消费。
        # 主键 = (path, method, query)；order = 源码顺序（**顺序承载语义**，见分组段）。
        rows = []
        for i, e in enumerate(entries, 1):
            rows.append({
                "id": i,
                "order": i,
                "path": e["path"],
                "method": e.get("method"),
                "query": e.get("query") or [],
                "kind": e["kind"],
                "line": e["line"],
            })
        print(json.dumps({
            "note": "表草稿：不是运行时路由表，也还没有被任何代码消费。order 承载语义，不许排序。",
            # 2026-11-01 —— `(path, method, query)` **不是唯一键**：实测 94 行里只有 57 个唯一值，
            # 其中 `("api", null, ())` 一组就占了 36 行（正则路由被提取器压成同一前缀）。
            # 而「同键多个分支」正是 `order` 承载的那一格语义 —— 顺序不在键里，
            # 保序就只活在注释里：一旦有人按下标排序输出，键会合并成一格而表仍看起来完整。
            # ⇒ 键必须带上 order（分支在源文件中的序位）。
            "key": ["path", "method", "query", "order"],
            "key_note": "order = 分支在源文件中的序位；它进键是因为 (path,method,query) 实测不唯一（40/94 行与人同键）",
            "rows": rows,
            "provenance": [l.lstrip("> ") for l in _provenance()],
        }, ensure_ascii=False, indent=1))
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
