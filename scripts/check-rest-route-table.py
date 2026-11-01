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
    return {
        "identical": False,
        "gone": sorted(ra - rb, key=str),
        "new": sorted(rb - ra, key=str),
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

    if not quiet: print(f"✓ selftest {5 - fails}/5 通过")
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
        key_problems = check_key_uniqueness(json.loads(fresh))
        if key_problems:
            for x in key_problems:
                print(f"✗ {x}", file=sys.stderr)
            return 1
        DATAFILE.write_text(fresh, encoding="utf-8")
        print(f"✓ 已写入 {DATAFILE.relative_to(REPO)}")
        # 2026-10-31 —— **证据列加一格：这次执行有没有改动被观测对象**。
        # 「可重跑」不等于「幂等」：带 --update 的这一次**改变了仓库内容**，
        # 于是它与上一次「只比较」的读数描述的不是同一个对象。
        print(f"  mutates_subject: YES（写入 {DATAFILE.relative_to(REPO)}；"
              f"下一次比较的基线已被这次执行改变）")
        return 0
    if not DATAFILE.exists():
        print(f"✗ 缺 {DATAFILE.relative_to(REPO)}；先跑 --update", file=sys.stderr)
        return 1
    committed = DATAFILE.read_text(encoding="utf-8")
    # 键唯一性：即使内容与源码一致，一份「键不能标识行」的表也不是可引用的清单。
    key_problems = check_key_uniqueness(json.loads(committed)) if committed.strip() else []
    if key_problems:
        for x in key_problems:
            print(f"✗ {x}", file=sys.stderr)
        print("  ⇒ 给 key 补一列（同键多分支时 order 是唯一能区分它们的），再 --update。", file=sys.stderr)
        return 1
    if committed == fresh:
        n = len(json.loads(fresh)["rows"])
        print(f"✓ 路由表草稿与源码一致（{n} 行，键唯一）")
        print("  mutates_subject: no（只读比较；本次执行未改变被观测文件）")
        print("  check: 重跑本脚本；源码里新增/移动一条匹配 ⇒ 这里会红，直到 --update。")
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
    print("  mutates_subject: no（只读比较；未写入任何文件）")
    print(f"✗ 路由表草稿**已过期**：文件 {len(a.get('rows', []))} 行 / 现在 {len(b.get('rows', []))} 行", file=sys.stderr)
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
