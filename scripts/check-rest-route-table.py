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
import os
from datetime import datetime, timezone
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GEN = REPO / "scripts" / "report-rest-endpoints.py"
# 2026-11-01 —— 路径可用环境变量覆盖，**只为一件事**：让「报差异」那条分支能被真的执行一次。
# 那条分支的唯一执行条件就是它要报告的那个条件（表过期），所以在正常 CI 里它永远绿在
# 另一条分支上 —— 「它绿着」与「它跑过并绿」同形。selftest 里用一份人造过期的副本喂它。
DATAFILE = Path(os.environ.get("ROUTE_TABLE_FILE") or (REPO / "docs" / "rest-route-table.json"))


def _disp(p: Path) -> str:
    """路径的显示形式：在仓内就相对，仓外就绝对。

    2026-11-01 —— `p.relative_to(REPO)` 在路径指向仓外时会抛 ValueError，
    而 --update 的**全部用途**就是「往参照文件里写」——它恰好是唯一会被喂仓外路径的那条路。
    于是 selftest 的 update→re-run 链第一次跑就崩在这里（而崩溃被读成「更新失败」）。
    """
    try:
        return str(p.relative_to(REPO))
    except ValueError:
        return str(p)


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
SOURCE = REPO / "server" / "src" / "server.ts"

# 2026-11-01 —— 写方法集合：判「写路由」靠它，所以它**只有一个定义**。
WRITE_METHODS = ("PUT", "POST", "PATCH", "DELETE")


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


def check_method_parse(doc: dict) -> list[str]:
    """表里 `method=None` 的行，必须在源码里**真的**不限方法。

    2026-11-01 —— 这条检查是「表说自己没错」之外的一份独立读数：
    它**重新读源码**、重新抽方法，而不是相信 `method_parse` 那一格的自述。

    为什么需要它：实测 24 条路由把方法判在**下一行**（`const X = …match(…)` 绑定、
    下一行 `if (X && req.method === "PUT")`）。只按同行抽 ⇒ 它们全是 `method=None`，
    而 `None` 在「按 method 判写路由」时被算成非写 ⇒ **7 条 PUT/POST + 3 条 DELETE
    落在分母外，且不产生任何红**。这不叫漏测，叫分母错了而报表看起来完整。

    三态，各自处置不同：
      · 源码里确实不限方法        ⇒ 合法缺省，不报
      · 绑定语句 + 引用它的 if 里恰一个方法 ⇒ **解析漏**，必须报（这是可以修的）
      · 那一行里有多个方法        ⇒ 单值字段容不下 ⇒ 只允许出现在 `method_parse.multi_method`
    """
    if not SOURCE.exists():
        return [f"SOURCE_MISSING: 读不到 {SOURCE.relative_to(REPO)} ⇒ 无法独立复核 method"]
    src = SOURCE.read_text(encoding="utf-8", errors="replace").splitlines()
    problems: list[str] = []
    misses: list[str] = []
    multis: list[tuple[str, int, tuple[str, ...]]] = []
    for r in doc.get("rows") or []:
        if r.get("method"):
            continue
        ln = int(r.get("line") or 0) - 1
        if not (0 <= ln < len(src)):
            continue
        cur = src[ln]
        # 同一行内就写了多个方法（`if (… && (req.method === "GET" || req.method === "POST"))`）
        # —— 这类行没有绑定语句，但它**同样是多方法**，必须进同一份登记。
        inline_multi = tuple(sorted(set(re.findall(r'req\.method\s*===\s*"([A-Z]+)"', cur))))
        if len(inline_multi) > 1:
            multis.append((str(r.get("path")), int(r.get("line") or 0), inline_multi))
            continue
        binding = re.match(r"\s*(?:const|let|var)\s+(\w+)\s*=", cur)
        if not binding:
            continue
        ident = binding.group(1)
        # 2026-11-01 —— 找「引用 ident 的 if」不能按**行数窗口**（上一版是「向下 3 行」）。
        # 窗口参数不可调：调窄漏掉隔了几行的 if，调宽会把相邻分支的 if 算进来。
        # 改成**括号配平**：从绑定行向下扫，直到这一层的块结束；遇到的第一个引用 ident 的 if 才算。
        hit = None
        depth = 0
        for k in range(ln, len(src)):
            line = src[k]
            depth += line.count("{") - line.count("}")
            if k > ln and depth < 0:
                break                      # 这一层已经结束
            if k > ln and re.match(r"\s*if\s*\(", line) and ident in line:
                hit = line
                break
        if hit is None:
            continue
        meths = tuple(sorted(set(re.findall(r'req\.method\s*===\s*"([A-Z]+)"', hit))))
        if len(meths) == 1:
            misses.append(f"第 {r.get('line')} 行 {r.get('path')}（源码判 {meths[0]}）")
        elif len(meths) > 1:
            multis.append((str(r.get("path")), int(r.get("line") or 0), meths))

    if misses:
        problems.append(
            f"METHOD_PARSE_MISS: {len(misses)} 行 method=None 但源码判了唯一方法"
            f"（{'; '.join(misses[:4])}…）⇒ 按 method 判写路由时它们被算成非写，"
            f"分母会小，而表看起来完整")

    registered = {(m.get("path"), int(m.get("line") or 0), tuple(m.get("methods") or ()))
                  for m in ((doc.get("method_parse") or {}).get("multi_method") or [])}
    unregistered = [m for m in multis if m not in registered]
    if unregistered:
        problems.append(
            f"MULTI_METHOD_UNREGISTERED: {len(unregistered)} 条多方法路由没进 method_parse.multi_method"
            f"（{unregistered[:2]}）⇒ 「多个方法」与「不限方法」在 method 列上同形，"
            f"而这两类对写路由判定相反")
    stale = registered - {m for m in multis}
    if stale:
        problems.append(
            f"MULTI_METHOD_STALE: method_parse 里登记了 {len(stale)} 条源码已不再如此的记录"
            f"（{sorted(stale)[:2]}）⇒ 登记表在腐化，读它的人会按旧名单理解今天")
    return problems


def write_route_count(doc: dict) -> tuple[int, int, int]:
    """写路由的三个数：单方法写 / 多方法里含写 / 合计。

    分开报的理由：多方法那 3 条在 `method` 列上是 None，
    只报合计时它们从哪来读不出来；只报单方法时它们又消失。
    """
    rows = doc.get("rows") or []
    w_single = sum(1 for r in rows if (r.get("method") or "") in WRITE_METHODS)
    multi = ((doc.get("method_parse") or {}).get("multi_method") or [])
    w_multi = sum(1 for m in multi if any(x in WRITE_METHODS for x in (m.get("methods") or ())))
    return w_single, w_multi, w_single + w_multi


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
    # 2026-11-01 —— 条数**不写字面量**：它由登记了几例派生。
    # 写死 `9 - fails` 时，加一例而忘了改 9 ⇒ 通过率会算出 10/9 之类的数，
    # 而那种数在终端上看起来只是「有点怪」，不会有人去查。
    cases: list[int] = []
    fails = 0

    d = diff_tables(same, same)
    ok = d["identical"] is True
    if not quiet: print(("✓" if ok else "✗") + " selftest 逐字节相同 ⇒ identical")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    # 方向：committed 是文件（旧），fresh 是现在生成的（新）。
    # 「文件里少一行」= 源码现在多一行 ⇒ new=1（第一版我写反了方向，自检当场抓到）。
    dropped = json.dumps({**base, "rows": base["rows"][:1]}, ensure_ascii=False)
    d = diff_tables(same, dropped)
    ok = (d["identical"] is False) and len(d["gone"]) == 1 and len(d["new"]) == 0
    if not quiet: print(("✓" if ok else "✗") + " selftest 文件多一行（源码删了它）⇒ gone=1 / new=0")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    # 关键：method=None 的行必须能参与比较而不抛异常（今晚真实崩溃的那一格）
    prov = json.dumps({**base, "provenance": ["gen from a.ts sha256=bbbb"]}, ensure_ascii=False)
    try:
        d = diff_tables(prov, same)
        ok = d["provenance_changed"] is True and d["gone"] == [] and d["new"] == []
    except TypeError:
        ok = False
    if not quiet: print(("✓" if ok else "✗") + " selftest 只有 provenance 变 ⇒ 报 provenance（且 method=None 不炸）")
    cases.append(0 if ok else 1)
    fails += cases[-1]
    # 2026-11-01 —— 键唯一性是**新加的一条**，它自己也要有「红过」的见证：
    #   (path,method,query) 在真实表里只有 57/94 唯一 ⇒ 那条真实数据就是负例的样子。
    kp = check_key_uniqueness({"key": ["path", "method", "query", "order"],
                               "rows": [{"path": "/a", "method": "GET", "query": [], "order": 1},
                                        {"path": "/a", "method": "GET", "query": [], "order": 2}]})
    ok = kp == []
    if not quiet: print(("✓" if ok else "✗") + " selftest 键带 order ⇒ 同 path 同 method 仍是两行")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    kp = check_key_uniqueness({"key": ["path", "method", "query"],
                               "rows": [{"path": "api", "method": None, "query": [], "order": 1},
                                        {"path": "api", "method": None, "query": [], "order": 2}]})
    ok = len(kp) == 1 and kp[0].startswith("KEY_NOT_UNIQUE")
    if not quiet: print(("✓" if ok else "✗") + " selftest 键不含 order ⇒ KEY_NOT_UNIQUE（2 行同键只算一格）")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    # 2026-11-01 —— 三条新的形状钉子，各自都要有「红过」的见证：
    ok = check_order_sequence({"rows": [{"order": 1}, {"order": 2}]}) == []
    if not quiet: print(("✓" if ok else "✗") + " selftest order == 数组顺序 ⇒ 无问题")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    ok = bool(check_order_sequence({"rows": [{"order": 1}, {"order": 9}]}))
    if not quiet: print(("✓" if ok else "✗") + " selftest order 与下标分叉 ⇒ ORDER_MISMATCH")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    ok = check_kind_enum({"rows": [{"kind": "eq"}, {"kind": "regex_prefix"}]}) == [] \
        and bool(check_kind_enum({"rows": [{"kind": "handler"}]}))
    if not quiet: print(("✓" if ok else "✗") + " selftest kind 闭集：已知三种过、handler 红")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    # 2026-11-01 —— 「报差异」这条分支此前**一次都没成功执行过**：
    # 它唯一的执行条件就是它要报告的那个条件（表过期），而在正常 CI 里表总是新的
    # ⇒ 它绿着，但那是另一条分支的颜色。这里人造一份过期表，喂给真进程。
    # 断言三件事：退出码 1（不是 2、不是异常）、说了「已过期」、**没有 traceback**。
    # 第二条最重要：它正是当年在要报错的场合抛 TypeError 的那一格。
    import tempfile
    cases.append(_selftest_update_then_check(quiet))
    cases.append(_selftest_diff_branch(quiet))
    fails += cases[-1]
    if not quiet: print(f"✓ selftest {len(cases) - fails}/{len(cases)} 通过")
    return 0 if fails == 0 else 1


def _selftest_update_then_check(quiet: bool) -> int:
    """`--update` 写入 → **立刻再跑一次** → 必须一致。

    2026-11-01 —— 「写完就一致」与「写入后又跑一次仍一致」是两条路径：
    前者只证明这次比较通过，后者才证明**基线被正确写入**。
    缺这一格时，「写完就一致」与「写入失败但别的原因让它一致」同形 ——
    而 `key=str` 那次崩溃就发生在这条从未被完整走过的路径上。
    """
    if os.environ.get("ROUTE_TABLE_SELFTEST_CHILD") == "1":
        return 0
    import tempfile
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            fh.write("{}")   # 故意给一份空表：--update 必须能把它写成真表
            tmp = fh.name
        env = dict(os.environ, ROUTE_TABLE_FILE=tmp, ROUTE_TABLE_SELFTEST_CHILD="1")
        up = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--update"],
                            capture_output=True, text=True, env=env, timeout=120)
        re_run = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                capture_output=True, text=True, env=env, timeout=120)
        out = (up.stdout or "") + (up.stderr or "") + (re_run.stdout or "") + (re_run.stderr or "")
        ok = (up.returncode == 0 and re_run.returncode == 0
              and "path: consistent" in (re_run.stdout or "")
              and "Traceback" not in out
              and "基线已更新至" in (up.stdout or ""))
        if not quiet:
            print(("✓" if ok else "✗") +
                  f" selftest --update → 立刻再跑 ⇒ 一致（update rc={up.returncode}、"
                  f"re-run rc={re_run.returncode}、报出基线={('基线已更新至' in (up.stdout or ''))}）")
        Path(tmp).unlink(missing_ok=True)
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            print(f"✗ selftest update→re-run 那一格跑不起来：{exc}")
        return 1


def _selftest_diff_branch(quiet: bool) -> int:
    """跑**真进程**，喂一份人造过期的表，断言它输出差异而不是崩。

    🔴 必须先把它做成**当下的**表（先跑一次 --update 到临时文件）再突变。
    直接拿仓库里那份来突变时，如果仓库那份本身就是过期的
    （刚改过 server.ts、还没 --update），别的检查会先红 ⇒ 这里测到的不是差异分支。
    「测到了别的分支」与「差异分支正常」在输出上都是 rc=1 —— 只有 `已过期` 这个词能分开。

    🔴 子进程会先跑它自己的 selftest ⇒ 没有 ROUTE_TABLE_SELFTEST_CHILD 守卫时这里会自我递归，
    表现是「跑到超时」，而超时会被读成「慢」，不是「无限递归」。
    """
    if os.environ.get("ROUTE_TABLE_SELFTEST_CHILD") == "1":
        return 0
    import tempfile
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            fh.write("{}")
            tmp = fh.name
        env = dict(os.environ, ROUTE_TABLE_FILE=tmp, ROUTE_TABLE_SELFTEST_CHILD="1")
        # ① 先把它变成「当下的表」
        up = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--update"],
                            capture_output=True, text=True, env=env, timeout=120)
        if up.returncode != 0:
            if not quiet:
                print(f"✗ selftest 差异分支：前置 --update 失败（rc={up.returncode}）")
            Path(tmp).unlink(missing_ok=True)
            return 1
        # ② 追加一行**合成的**路由（文件里有、源码里没有）
        doc = json.loads(Path(tmp).read_text(encoding="utf-8"))
        rows = doc.get("rows") or []
        rows.append({"id": len(rows) + 1, "order": len(rows) + 1,
                     "path": "/__selftest_ghost__", "method": "GET",
                     "query": [], "kind": "eq", "line": 1})
        Path(tmp).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        # ③ 真进程跑差异分支
        res = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                             capture_output=True, text=True, env=env, timeout=120)
        out = (res.stdout or "") + (res.stderr or "")
        ok = (res.returncode == 1 and "已过期" in out and "Traceback" not in out)
        if not quiet:
            print(("✓" if ok else "✗") +
                  f" selftest 人造过期 ⇒ 报差异不崩（rc={res.returncode}·"
                  f"说已过期={'已过期' in out}·无 traceback={'Traceback' not in out}）")
        Path(tmp).unlink(missing_ok=True)
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            print(f"✗ selftest 人造过期那一格跑不起来：{exc}")
        return 1


# 2026-11-01 —— 本次**走了哪条分支**，一行。
#
# 这个脚本有四条出口（updated / consistent / problems / diff_reported），
# 而「报差异」那条的唯一执行条件就是它要报告的那个条件 —— 于是它平时永远不跑，
# 而「它绿着」与「它跑过并绿」在输出上同形。一行 print 让「从未执行」第一次成为可见状态。
def _branch(name: str) -> None:
    print(f"  path: {name}")


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
                        + check_kind_enum(json.loads(fresh))
                        + check_method_parse(json.loads(fresh)))
        if key_problems:
            for x in key_problems:
                print(f"✗ {x}", file=sys.stderr)
            return 1
        DATAFILE.write_text(fresh, encoding="utf-8")
        print(f"✓ 已写入 {_disp(DATAFILE)}")
        # 2026-10-31 —— **证据列加一格：这次执行有没有改动被观测对象**。
        # 「可重跑」不等于「幂等」：带 --update 的这一次**改变了仓库内容**，
        # 于是它与上一次「只比较」的读数描述的不是同一个对象。
        # 2026-11-01 —— 三档，不是两档：
        #   subject  ⇒ 写了**被观测对象本身**（表），内容变了
        #   baseline ⇒ 只改写「下一次比较的参照」——对象在这一刻是对的，但下一次的合格线变了
        #   none     ⇒ 这次运行对后续无影响
        # 二值的 no/YES 把「没碰」与「碰了参照」压成一格，而后者正是 --update 的全部作用。
        # 2026-11-01 —— **必须报出更新到了什么**，而不只是「更新过了」：
        # 只写「mutates: baseline」时，「更新后再跑一次绿」与「一直在绿」在报表上同形，
        # 而前者是一次**期望值被移动**之后取得的绿 —— 移动的方向由当次缺陷决定。
        _new = json.loads(fresh)
        _sha = ((_new.get("generator") or {}).get("sha256") or "")[:12]
        _src = ((_new.get("provenance") or [""])[0] or "")
        print(f"  mutates: baseline（写入 {_disp(DATAFILE)} = **参照**；"
              f"对象此刻与源码一致，但下一次比较的合格线已被这次执行改变）")
        print(f"  基线已更新至：generator sha256={_sha} · {_src} · @ {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
        _branch("updated")
        return 0
    if not DATAFILE.exists():
        print(f"✗ 缺 {_disp(DATAFILE)}；先跑 --update", file=sys.stderr)
        return 1
    committed = DATAFILE.read_text(encoding="utf-8")
    # 键唯一性：即使内容与源码一致，一份「键不能标识行」的表也不是可引用的清单。
    _doc = json.loads(committed) if committed.strip() else {}
    key_problems = (check_key_uniqueness(_doc) + check_order_sequence(_doc)
                    + check_kind_enum(_doc) + check_generator_identity(_doc)
                    + check_no_production_consumer() + check_method_parse(_doc))
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
            "METHOD_PARSE_MISS": "生成器的 method 抽取没覆盖这种写法：补上规则再 --update（不要手工填表）。",
            "MULTI_METHOD_UNREGISTERED": "把这条多方法路由登记进 method_parse.multi_method，再 --update。",
            "MULTI_METHOD_STALE": "源码已不再多方法 ⇒ 从 method_parse 里删掉，再 --update。",
            "SOURCE_MISSING": "先确认 source_domain 指向的文件还在；域变了要同时改生成器与这里。",
        }
        for x in key_problems:
            for k, h in hints.items():
                if x.startswith(k):
                    print(f"  ⇒ {h}", file=sys.stderr)
                    break
        _branch("problems")
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
        _branch("consistent")
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
    # 这一段就是当年在「要报告过期」的场合抛 TypeError 的地方。现在有名字了：
    # 崩了要打 `path: crashed` 并按「拿不到读数」退出（2），而不是混成 1。
    try:
        gone, new = sorted(ra - rb, key=str), sorted(rb - ra, key=str)
    except Exception as exc:  # noqa: BLE001
        print(f"::error::差异计算崩溃：{type(exc).__name__}: {exc}", file=sys.stderr)
        _branch("crashed")
        return 2
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
    _branch("diff_reported")
    return 1


if __name__ == "__main__":
    sys.exit(main())
