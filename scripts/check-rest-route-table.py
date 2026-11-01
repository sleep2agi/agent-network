#!/usr/bin/env python3
"""`docs/rest-route-table.json` 的**消费者**：它必须等于「现在重新生成一次」的结果。

2026-10-31 —— 为什么需要：生成物自己写着「重跑后不一致 ⇒ 本文档过期」，
但没有任何东西去重跑。⇒ 一份生成物的唯一风险不是它错，是它**停在过去某一天**，
而它读起来和今天一样。

口径：
  重新跑 `scripts/report-rest-endpoints.py --table-json`，与仓库里的文件逐字节比。
  不一致 ⇒ 红，并打印**差在哪**（行数、增删的 path、order 变化）。
  与 source 的 ref 不一致但内容相同（只有 provenance 里的 ref 变了）⇒ 也只报这一格，
  因为那说明「源码没动，只是换了提交」——仍然要更新，否则 ref 是假的。

用法：python3 scripts/check-rest-route-table.py [--update]
退出码：0 = 一致；1 = 过期；2 = 拿不到读数（生成器失败）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GEN = REPO / "scripts" / "report-rest-endpoints.py"
DATAFILE = REPO / "docs" / "rest-route-table.json"


# 2026-11-01 —— `kind` 是**闭集**：它看起来是描述性字段，而描述性字段的边界
# 天然被当成可以自由扩展 ⇒ 三次提交内会长出 handler / route / branch / endpoint
# 这些近义词，而那时按它分组的统计已经不可比。所以值域在落地这一轮就封死。
KIND_ENUM = {"eq", "regex_prefix", "starts_with"}

# order 与数组顺序是同一件事写了两次 —— 必须断言二者一致，否则双写会分叉，
# 而分叉在 diff 里完全看不见（两处都是同一个文件里的数字）。
def check_order_sequence(doc: dict) -> list[str]:
    rows = doc.get("rows") or []
    problems = []
    for i, r in enumerate(rows):
        want = i + 1
        if r.get("order") != want:
            problems.append(f"ORDER_MISMATCH: 第 {i + 1} 行的 order={r.get('order')}"
                            f"（数组顺序）≠ {want} —— 「保序」被双写成两个值")
            break
    return problems


def check_kind_enum(doc: dict) -> list[str]:
    rows = doc.get("rows") or []
    unknown = sorted({str(r.get("kind")) for r in rows if r.get("kind") not in KIND_ENUM})
    if unknown:
        return [f"KIND_UNKNOWN: {unknown} 不在闭集 {sorted(KIND_ENUM)} 里"
                f" —— 新增分类要改 KIND_ENUM 并说明为什么旧的三种不够"]
    return []


def check_generator_identity(doc: dict) -> list[str]:
    """生成器的内容身份必须与当前文件一致。

    不一致 ⇒ 「表变了」这句话有两个可能的主语：路由变了，或抽取逻辑变了。
    两者的处置相反（改路由代码 / 改这个脚本），所以必须先比生成器再比表。
    """
    import hashlib
    from pathlib import Path as _P
    gen = doc.get("generator") or {}
    rel, recorded = gen.get("path"), gen.get("sha256")
    if not rel or not recorded:
        return ["GENERATOR_UNPINNED: 表里没有记录生成器的内容身份 ⇒ 「表变了」没有主语"]
    path = REPO / rel
    if not path.exists():
        return [f"GENERATOR_MISSING: {rel} 不存在"]
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != recorded:
        return [f"GENERATOR_CHANGED: {rel} 的 sha256 从 {recorded[:12]} 变成 {actual[:12]}"
                f" —— 先确认这一轮变的是**抽取逻辑**还是**路由**，再 --update"]
    return []


# 「仓内没有消费者」需要一个**消费者数量 == 0 的断言**，否则它只是当前状态：
# 安全性依赖「没人恰好用到它」不是设计。失效形态是一行 `rest-route-table.json`
# 出现在某个新功能里 —— 而那行代码看起来完全正常。
# 生产源码（server/src 下非测试文件）里出现这个文件名 ⇒ 表从「构建期自洽」变成
# 「运行时依赖」，那时 runtime_claim 那句话就不成立了，必须红。
PRODUCTION_GLOBS = ("server/src/**/*.ts",)
TABLE_NAME = "rest-route-table.json"


def check_no_production_consumer() -> list[str]:
    hits = []
    for pat in PRODUCTION_GLOBS:
        for f in REPO.glob(pat):
            if ".test." in f.name:
                continue
            try:
                body = f.read_text()
            except OSError:
                continue
            for i, line in enumerate(body.splitlines(), 1):
                if TABLE_NAME in line:
                    hits.append(f"{f.relative_to(REPO)}:{i}")
    if hits:
        return [f"TABLE_CONSUMED_BY_PRODUCTION: {TABLE_NAME} 出现在 {len(hits)} 处生产源码里"
                f"（{', '.join(hits[:3])}）⇒ 表已成运行时依赖，runtime_claim 的「非运行时事实」不再成立"]
    return []


def check_key_uniqueness(doc: dict) -> list[str]:
    """声明的 `key` 必须真的能标识行 —— 否则它是注释，不是键。

    2026-11-01 —— 实测：`(path, method, query)` 在 94 行里只有 57 个唯一值
    （`("api", null, ())` 一组占 36 行）。那种表**看起来完整**，
    因为重复行并排摆着；但任何「按键索引」的读者都会只拿到最后一支。
    而且它丢掉的恰好是 `order` 承载的那一格语义：同键多个分支的先后。

    所以这里断言：按声明的 key 取元组，行数与唯一键数必须相等。
    不等 ⇒ 红，并打印组数与最大一组（读的人立刻知道该给键补哪一列）。
    """
    rows = doc.get("rows") or []
    key = doc.get("key") or []
    if not rows or not key:
        return ["KEY_SHAPE: 表里没有 rows 或没有声明 key"]
    from collections import Counter
    tuples = [tuple(str(r.get(k)) for k in key) for r in rows]
    counts = Counter(tuples)
    dups = {k: v for k, v in counts.items() if v > 1}
    if dups:
        biggest = max(dups.values())
        worst = [k for k, v in dups.items() if v == biggest][0]
        return [f"KEY_NOT_UNIQUE: key={key} 只给出 {len(counts)} 个唯一值 / {len(rows)} 行；"
                f"{len(dups)} 组同键，最大一组 {biggest} 行（例：{worst[:2]}）"]
    return []


def generate() -> str | None:
    try:
        res = subprocess.run([sys.executable, str(GEN), "--table-json"],
                             cwd=REPO, capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 生成器跑不起来：{exc}", file=sys.stderr)
        return None
    if res.returncode != 0:
        print(f"✗ 生成器 exit={res.returncode}", file=sys.stderr)
        print(res.stderr[:400], file=sys.stderr)
        return None
    try:
        json.loads(res.stdout)
    except Exception:  # noqa: BLE001
        print("✗ 生成器 stdout 不是 JSON", file=sys.stderr)
        return None
    return res.stdout


def diff_tables(committed: str, fresh: str) -> dict:
    """比较两份表的**纯函数**（从 main 里抽出来，才能自检）。

    返回 {identical, gone, new, provenance_changed, rows_committed, rows_fresh}。
    抽出来的理由很实际：这段比较逻辑今晚修过一次真实崩溃（method=None 时 sorted 抛 TypeError，
    而且恰好在它要报告「已过期」的场合崩溃）—— 那种地方必须有自检，否则下次还会静默炸。
    """
    if committed == fresh:
        return {"identical": True, "gone": [], "new": [], "provenance_changed": False,
                "rows_committed": len(json.loads(fresh).get("rows", [])), "rows_fresh": len(json.loads(fresh).get("rows", []))}
    a, b = json.loads(committed), json.loads(fresh)
    ra = {(r["path"], r.get("method"), tuple(r.get("query") or []), r["line"]) for r in a.get("rows", [])}
    rb = {(r["path"], r.get("method"), tuple(r.get("query") or []), r["line"]) for r in b.get("rows", [])}

    # 2026-11-01 —— 行数相等**不等于**内容相等：改一行（92→92）只能报「内容不一致」，
    # 而「改一个 method」恰是最常见的一类。所以报**首个不一致的行号与两侧内容**，
    # 长度差只当快速信号。这一格的检出成本决定这张表会不会真的有人维护。
    first_diff = None
    rows_a, rows_b = a.get("rows", []), b.get("rows", [])
    for i in range(min(len(rows_a), len(rows_b))):
        if rows_a[i] != rows_b[i]:
            first_diff = {"index": i + 1, "committed": rows_a[i], "fresh": rows_b[i]}
            break

    return {
        "identical": False,
        "gone": sorted(ra - rb, key=str),
        "new": sorted(rb - ra, key=str),
        "first_diff": first_diff,
        "provenance_changed": a.get("provenance") != b.get("provenance"),
        "rows_committed": len(a.get("rows", [])),
        "rows_fresh": len(b.get("rows", [])),
    }


def selftest(quiet: bool = False) -> int:
    """三例：逐字节相同 / 少一行 / 只有 provenance 变（后者也必须报）。"""
    base = {"rows": [{"path": "/api/a", "method": "GET", "query": [], "line": 1},
                     {"path": "/api/b", "method": None, "query": ["x"], "line": 2}],
            "provenance": ["gen from a.ts sha256=aaaa"]}
    same = json.dumps(base, ensure_ascii=False)
    fails = 0

    d = diff_tables(same, same)
    ok = d["identical"] is True
    if not quiet: print(("✓" if ok else "✗") + " selftest 逐字节相同 ⇒ identical")
    fails += 0 if ok else 1

    # 方向：committed 是文件（旧），fresh 是现在生成的（新）。
    # 「文件里少一行」= 源码现在多一行 ⇒ new=1（第一版我写反了方向，自检当场抓到）。
    dropped = json.dumps({**base, "rows": base["rows"][:1]}, ensure_ascii=False)
    d = diff_tables(same, dropped)
    ok = (d["identical"] is False) and len(d["gone"]) == 1 and len(d["new"]) == 0
    if not quiet: print(("✓" if ok else "✗") + " selftest 文件多一行（源码删了它）⇒ gone=1 / new=0")
    fails += 0 if ok else 1

    # 关键：method=None 的行必须能参与比较而不抛异常（今晚真实崩溃的那一格）
    prov = json.dumps({**base, "provenance": ["gen from a.ts sha256=bbbb"]}, ensure_ascii=False)
    try:
        d = diff_tables(prov, same)
        ok = d["provenance_changed"] is True and d["gone"] == [] and d["new"] == []
    except TypeError:
        ok = False
    if not quiet: print(("✓" if ok else "✗") + " selftest 只有 provenance 变 ⇒ 报 provenance（且 method=None 不炸）")
    fails += 0 if ok else 1
    # 2026-11-01 —— 键唯一性是**新加的一条**，它自己也要有「红过」的见证：
    #   (path,method,query) 在真实表里只有 57/94 唯一 ⇒ 那条真实数据就是负例的样子。
    kp = check_key_uniqueness({"key": ["path", "method", "query", "order"],
                               "rows": [{"path": "/a", "method": "GET", "query": [], "order": 1},
                                        {"path": "/a", "method": "GET", "query": [], "order": 2}]})
    ok = kp == []
    if not quiet: print(("✓" if ok else "✗") + " selftest 键带 order ⇒ 同 path 同 method 仍是两行")
    fails += 0 if ok else 1

    kp = check_key_uniqueness({"key": ["path", "method", "query"],
                               "rows": [{"path": "api", "method": None, "query": [], "order": 1},
                                        {"path": "api", "method": None, "query": [], "order": 2}]})
    ok = len(kp) == 1 and kp[0].startswith("KEY_NOT_UNIQUE")
    if not quiet: print(("✓" if ok else "✗") + " selftest 键不含 order ⇒ KEY_NOT_UNIQUE（2 行同键只算一格）")
    fails += 0 if ok else 1

    # 2026-11-01 —— 三条新的形状钉子，各自都要有「红过」的见证：
    ok = check_order_sequence({"rows": [{"order": 1}, {"order": 2}]}) == []
    if not quiet: print(("✓" if ok else "✗") + " selftest order == 数组顺序 ⇒ 无问题")
    fails += 0 if ok else 1

    ok = bool(check_order_sequence({"rows": [{"order": 1}, {"order": 9}]}))
    if not quiet: print(("✓" if ok else "✗") + " selftest order 与下标分叉 ⇒ ORDER_MISMATCH")
    fails += 0 if ok else 1

    ok = check_kind_enum({"rows": [{"kind": "eq"}, {"kind": "regex_prefix"}]}) == [] \
        and bool(check_kind_enum({"rows": [{"kind": "handler"}]}))
    if not quiet: print(("✓" if ok else "✗") + " selftest kind 闭集：已知三种过、handler 红")
    fails += 0 if ok else 1

    if not quiet: print(f"✓ selftest {8 - fails}/8 通过")
    return 0 if fails == 0 else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    fresh = generate()
    if fresh is None:
        return 2
    if "--update" in sys.argv:
        # 写之前先验键：一份「键不唯一」的表写进仓库，等于把注释当键焊死。
        key_problems = (check_key_uniqueness(json.loads(fresh))
                        + check_order_sequence(json.loads(fresh))
                        + check_kind_enum(json.loads(fresh)))
        if key_problems:
            for x in key_problems:
                print(f"✗ {x}", file=sys.stderr)
            return 1
        DATAFILE.write_text(fresh, encoding="utf-8")
        print(f"✓ 已写入 {DATAFILE.relative_to(REPO)}")
        # 2026-10-31 —— **证据列加一格：这次执行有没有改动被观测对象**。
        # 「可重跑」不等于「幂等」：带 --update 的这一次**改变了仓库内容**，
        # 于是它与上一次「只比较」的读数描述的不是同一个对象。
        # 2026-11-01 —— 三档，不是两档：
        #   subject  ⇒ 写了**被观测对象本身**（表），内容变了
        #   baseline ⇒ 只改写「下一次比较的参照」——对象在这一刻是对的，但下一次的合格线变了
        #   none     ⇒ 这次运行对后续无影响
        # 二值的 no/YES 把「没碰」与「碰了参照」压成一格，而后者正是 --update 的全部作用。
        print(f"  mutates: baseline（写入 {DATAFILE.relative_to(REPO)} = **参照**；"
              f"对象此刻与源码一致，但下一次比较的合格线已被这次执行改变）")
        return 0
    if not DATAFILE.exists():
        print(f"✗ 缺 {DATAFILE.relative_to(REPO)}；先跑 --update", file=sys.stderr)
        return 1
    committed = DATAFILE.read_text(encoding="utf-8")
    # 键唯一性：即使内容与源码一致，一份「键不能标识行」的表也不是可引用的清单。
    _doc = json.loads(committed) if committed.strip() else {}
    key_problems = (check_key_uniqueness(_doc) + check_order_sequence(_doc)
                    + check_kind_enum(_doc) + check_generator_identity(_doc)
                    + check_no_production_consumer())
    if key_problems:
        for x in key_problems:
            print(f"✗ {x}", file=sys.stderr)
        # 每一类问题给**各自的**下一步 —— 一句写死的提示会把修法指错。
        hints = {
            "KEY_NOT_UNIQUE": "给 key 补一列（同键多分支时 order 是唯一能区分它们的），再 --update。",
            "ORDER_MISMATCH": "order 与数组顺序双写分叉了：改生成器让二者同源，再 --update。",
            "KIND_UNKNOWN": "新分类先加进 KIND_ENUM 并说明旧的三种为什么不够，再 --update。",
            "GENERATOR_CHANGED": "先确认变的是抽取逻辑还是路由，再 --update；两者不可混在一次对比里。",
            "GENERATOR_UNPINNED": "生成器要在产物里记 sha256，否则「表变了」没有主语。",
        }
        for x in key_problems:
            for k, h in hints.items():
                if x.startswith(k):
                    print(f"  ⇒ {h}", file=sys.stderr)
                    break
        return 1
    if committed == fresh:
        n = len(json.loads(fresh)["rows"])
        print(f"✓ 路由表草稿与源码一致（{n} 行，键唯一）")
        print("  mutates: none（只读比较；未写入任何文件）")
        print("  check: 重跑本脚本；源码里新增/移动一条匹配 ⇒ 这里会红，直到 --update。")
        # 2026-11-01 —— 绿的时候也要说清它**没**证明什么：
        # 这是构建期自洽，不是运行时事实；没有这一行，绿会被读成「路由已被覆盖」。
        claim = _doc.get("runtime_claim") or {}
        if claim.get("is_runtime_fact") is False:
            print(f"  ⚠ 非运行时事实：{claim.get('why')}")
            print(f"    升级出口：{claim.get('upgrade_condition')}")
        dom = _doc.get("source_domain") or {}
        if dom:
            print(f"  哈希域：{dom.get('files')}（{dom.get('granularity')}）—— "
                  f"{dom.get('known_bias', '')[:40]}…")
        return 0

    # 差在哪：行数与增删的 path
    try:
        a = json.loads(committed)
        b = json.loads(fresh)
    except Exception:  # noqa: BLE001
        print("✗ 有一侧不是合法 JSON ⇒ 无法给出差异，只能说过期", file=sys.stderr)
        return 1
    ra = {(r["path"], r.get("method"), tuple(r.get("query") or []), r["line"]) for r in a.get("rows", [])}
    rb = {(r["path"], r.get("method"), tuple(r.get("query") or []), r["line"]) for r in b.get("rows", [])}
    # 2026-10-31 —— 修一个真实崩溃：tuple 里 method 可能是 None，
    # 而 `sorted()` 在比较 (str, None, …) 时抛 TypeError ⇒ **恰好在它要报告的场合崩溃**。
    # （实测：给 server.ts 加了几行注释导致行号平移，本脚本没有报「过期」，而是抛异常。）
    gone, new = sorted(ra - rb, key=str), sorted(rb - ra, key=str)
    print("  mutates: none（只读比较；未写入任何文件）")
    print(f"✗ 路由表草稿**已过期**：文件 {len(a.get('rows', []))} 行 / 现在 {len(b.get('rows', []))} 行", file=sys.stderr)
    d = diff_tables(committed, fresh)
    if d.get("first_diff"):
        fd = d["first_diff"]
        print(f"  首个不一致在第 {fd['index']} 行：", file=sys.stderr)
        print(f"    文件里：{json.dumps(fd['committed'], ensure_ascii=False)}", file=sys.stderr)
        print(f"    现在  ：{json.dumps(fd['fresh'], ensure_ascii=False)}", file=sys.stderr)
    # 2026-11-01 —— 报「预期红频率」，让这个数可被审：
    # 高一个数量级会训练出忽略（忽略一旦形成，与「从未触发」在报表上同形），
    # 低一个数量级会漏。
    print("  预期红频率：**只在 server/src/server.ts 变化时**（本检查器不读别的文件）；"
          "改注释也会红 —— 见 source_domain", file=sys.stderr)
    for g in gone[:5]:
        print(f"    文件里有、源码里没有：{g}", file=sys.stderr)
    for n in new[:5]:
        print(f"    源码里有、文件里没有：{n}", file=sys.stderr)
    if a.get("provenance") != b.get("provenance"):
        print(f"    provenance 也变了：{a.get('provenance', [None])[0]} → {b.get('provenance', [None])[0]}", file=sys.stderr)
    print("  ⇒ python3 scripts/check-rest-route-table.py --update", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
