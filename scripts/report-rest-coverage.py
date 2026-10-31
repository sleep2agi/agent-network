#!/usr/bin/env python3
"""REST 侧的覆盖率分母 —— 「94 条路由里有几条被测试碰过」。

2026-10-31 起因（卡 #3214）：
    MCP 侧有注册表（`server.tool("name")` ⇒ 88 个，可穷举），所以覆盖率算得出 35/88；
    REST 侧按 `url.pathname` 手写匹配，**没有注册点** ⇒ 「有断言的端点 / 全部端点」在这半边是 0/0，
    而 0/0 与「全部覆盖」在每一份报告里长得一样。

本脚本做的不是重构，只把**分母**先立起来：
    分母 = docs/rest-route-table.json 里的路由条数（那是从 server.ts 生成、并由
           scripts/check-rest-route-table.py 守着不许漂移的清单）
    分子 = 路径字面量在 `server/src/*.test.ts` 里出现过几条

判据必须诚实：
    「测试里出现过这个路径」 ≠ 「这个端点的响应形状被断言过」。
    前者只说明**有人打过它**（哪怕只断言了 401）。所以这里报两档：
      referenced   —— 测试里出现过路径字面量
      unreferenced —— **一条测试都没有**（这是最强的缺口，也是唯一能当红用的那一档）

用法：
    python3 scripts/report-rest-coverage.py            # 人读
    python3 scripts/report-rest-coverage.py --json
    python3 scripts/report-rest-coverage.py --fail-on-unreferenced   # 有未引用端点 ⇒ exit 1

退出码：0 有读数且（默认）不管缺口；1 仅当 --fail-on-unreferenced 且存在未引用端点；2 没有分母。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TABLE = REPO / "docs" / "rest-route-table.json"
TEST_GLOB = "server/src/*.test.ts"

# 路由表里的 path 有两种形态：`/api/foo` 这类等值匹配，与带参数的正则前缀。
# 只对**等值**那些报「有没有测试引用」；正则前缀（如 `ws`、`/api/nodes/`）不逐个报，
# 否则会把「一个前缀覆盖多条路径」误算成多条缺口。
LITERAL = re.compile(r"^/[A-Za-z0-9_\-/.]+$")


def load_routes() -> list[dict] | None:
    if not TABLE.is_file():
        print(f"✗ 找不到 {TABLE.relative_to(REPO)} ⇒ 没有分母", file=sys.stderr)
        return None
    try:
        doc = json.loads(TABLE.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 路由表不是 JSON：{exc}", file=sys.stderr)
        return None
    rows = doc.get("rows") or []
    if not rows:
        print("✗ 路由表里 0 条 ⇒ 没有分母（空表不是「全覆盖」）", file=sys.stderr)
        return None
    return rows


def keyset_sites() -> list[tuple[str, int]]:
    """所有 `Object.keys(...)` 出现在测试里的位置（文件, 行号）。

    2026-10-31 —— 与 #3275 合并推进：REST 侧原来只回答「这个路径被测试提到过吗」，
    但「提到」不等于「形状被断言过」。这里加一列：该路径出现的位置 30 行内有没有键集断言。
    ⚠️ 仍是代理：Keyset 可能属于**同文件里的另一个端点**（与 MCP 报告同一个已知误报面）。
    """
    out: list[tuple[str, int]] = []
    for p in sorted(REPO.glob(TEST_GLOB)):
        try:
            for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if "Object.keys(" in line:
                    out.append((p.name, i))
        except OSError:
            continue
    return out


ROUTE_LITERAL = re.compile(r"/(?:api|ws|events)/[A-Za-z0-9_\-/.]*")
CONST_DEF = re.compile(r"\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]")


class MentionIndex:
    """2026-10-31 —— 路由被**藏在本地助手**后面的情形。

    为什么需要：mention 的判定原来是「路径字面量出现在这一行」。测试把路由写进一个
    本地 builder（`const query = (k, s) => `/api/node-lifecycle-requests?...`` 很常见），
    **真正的调用点**那几行里没有路径字面量 ⇒ 键集断言即使紧贴调用点，
    也会因为「离字面量 100 多行」被算成没钉。

    这里只做很窄的一件事：定义行 + 后两行内**恰好**出现一条路由时，
    把 `NAME(` 的调用点登记为该路由的额外 mention 点。
    刻意不做全量数据流 —— 一个别名指向两条路由就放弃（宁可不认，也不猜）。
    """

    def __init__(self, corpus_lines: list[tuple[str, int, str]]):
        self.by_file: dict[str, dict[int, str]] = {}
        for f, ln, text in corpus_lines:
            self.by_file.setdefault(f, {})[ln] = text
        # (file, alias) -> route
        self.alias: dict[tuple[str, str], str] = {}
        for f, lines in self.by_file.items():
            for ln, text in lines.items():
                m = CONST_DEF.match(text)
                if not m:
                    continue
                seen: set[str] = set()
                for k in (ln, ln + 1, ln + 2):
                    t = lines.get(k)
                    if t is None:
                        continue
                    seen.update(r.rstrip(".") for r in ROUTE_LITERAL.findall(t))
                if len(seen) == 1:
                    self.alias[(f, m.group(1))] = next(iter(seen))

    def iter_lines(self):
        for f, lines in self.by_file.items():
            for ln, text in lines.items():
                yield f, ln, text

    def lines_for(self, path: str) -> list[tuple[str, int, str]]:
        out: list[tuple[str, int]] = []
        aliases: dict[str, list[str]] = {}
        for (f, name), route in self.alias.items():
            if route == path:
                aliases.setdefault(f, []).append(name)
        for f, lines in self.by_file.items():
            names = aliases.get(f, [])
            pats = [re.compile(rf"\b{re.escape(n)}\s*\(") for n in names]
            for ln, text in lines.items():
                literal = path in text
                alias = any(pt.search(text) for pt in pats)
                if literal:
                    out.append((f, ln, "literal"))
                elif alias:
                    out.append((f, ln, "alias"))
        return out


def keyset_near(index: MentionIndex, keyset: list[tuple[str, int]], path: str, window: int = 30) -> set[str]:
    """返回**认这条路路由的提及方式**集合：{"literal"} / {"alias"} / 两者。

    2026-10-31 —— 之前只返回布尔。布尔藏了一件事：口径变过之后，
    「为什么它现在算钉上了」无从追问。这里把依据一并交出去。
    """
    by_file: dict[str, list[int]] = {}
    for f, ln in keyset:
        by_file.setdefault(f, []).append(ln)
    via: set[str] = set()
    for f, ln, kind in index.lines_for(path):
        for kl in by_file.get(f, []):
            if abs(kl - ln) <= window:
                via.add(kind)
                break
    return via


def test_corpus() -> str:
    out: list[str] = []
    for p in sorted(REPO.glob(TEST_GLOB)):
        try:
            out.append(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
    return "\n".join(out)


def classify(rows: list[dict], corpus: str, mention_index: "MentionIndex | None" = None, keyset=None) -> dict:
    literal = [r for r in rows if isinstance(r.get("path"), str) and LITERAL.match(r["path"])]
    referenced, unreferenced, with_keyset, alias_only = [], [], [], []
    for r in literal:
        # 用路径字面量做检索：模板串里写 `${id}` 的调用点不会命中，这是**已知漏报方向**
        # （宁可少算引用，也不要多算 —— 报出一个假的「已覆盖」比报一个假的缺口更糟）。
        key = r["path"]
        if key not in corpus:
            unreferenced.append(key)
            continue
        referenced.append(key)
        # 2026-10-31 —— 「被提到」≠「形状被断言过」：再看该路径附近的 30 行内有没有键集断言
        if keyset is not None:
            via = keyset_near(mention_index, keyset, key)
            if via:
                with_keyset.append(key)
                if via == {"alias"}:
                    alias_only.append(key)
    return {
        "endpoints_total": len(rows),
        "endpoints_literal": len(literal),
        "prefix_rows": len(rows) - len(literal),
        "referenced": sorted(set(referenced)),
        "unreferenced": sorted(set(unreferenced)),
        "with_keyset": sorted(set(with_keyset)),
        "keyset_via_local_builder_only": sorted(set(alias_only)),
    }


def _measured_by() -> dict:
    """2026-10-31 —— **一个绿属于（被测物，测法）二元组**（外部复核：
    「向量表更新而制品没变 ⇒ 测试显示『旧字节通过了新向量』⇒ 那个绿同时属于两对，
      而你分不清是哪一对。」）

    树的 ref 在别处已记；这里补**尺子自己的版本**：
    脚本本体 sha256 前 12 位 + 解释器版本。改过口径（例如改过正则）之后，
    读的人能判断「数字变了」是代码变了还是尺子变了。
    """
    import hashlib as _h
    import platform as _pf
    import sys as _sys
    try:
        digest = _h.sha256(Path(__file__).read_bytes()).hexdigest()[:12]
    except OSError:
        digest = "unreadable"
    return {"script": Path(__file__).name, "sha256_12": digest,
            "python": _sys.version.split()[0], "os": _pf.system()}


def main(argv: list[str]) -> int:
    rows = load_routes()
    if rows is None:
        return 2
    lines: list[tuple[str, int, str]] = []
    for p in sorted(REPO.glob(TEST_GLOB)):
        try:
            for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                lines.append((p.name, i, line))
        except OSError:
            continue
    index = MentionIndex(lines)
    res = classify(rows, test_corpus(), index, keyset_sites())

    if "--json" in argv:
        print(json.dumps({
            "instrument": "report-rest-coverage",
            "measured_by": _measured_by(),
            "evidence_domain": "source",
            "counts": {
                "endpoints_total": res["endpoints_total"],
                "endpoints_literal": res["endpoints_literal"],
                "prefix_rows": res["prefix_rows"],
                "referenced": len(res["referenced"]),
                "unreferenced": len(res["unreferenced"]),
                "with_keyset_near": len(res["with_keyset"]),
                # 口径说明：这几个端点在测试里**没有**字面量调用点，形状断言是跟着
                # 本地 builder 别名认出来的（见 MentionIndex）。改过口径就要能被指认。
                "keyset_via_local_builder_only": res["keyset_via_local_builder_only"],
            },
            "unreferenced": res["unreferenced"],
            "covers": "REST 路由的**等值路径**在 server/src/*.test.ts 里是否被提到",
            "does_not_cover": [
                "模板串调用（`/api/nodes/${id}`）不会被算作引用 ⇒ 已知漏报方向",
                "被提到 ≠ 响应形状被断言（可能只断言了 401）",
                "正则前缀路由（ws 等）不逐个报",
            ],
        }, ensure_ascii=False, indent=2))
        if "--fail-on-unreferenced" in argv and res["unreferenced"]:
            return 1
        return 0

    print(f"REST-COVERAGE v1 endpoints={res['endpoints_total']} literal={res['endpoints_literal']} "
          f"prefix={res['prefix_rows']} referenced={len(res['referenced'])} "
          f"unreferenced={len(res['unreferenced'])} "
          f"keyset_near={len(res['with_keyset'])}/{len(res['referenced'])}")
    if res["unreferenced"]:
        print("  一条测试都没有的端点（最强的缺口）：")
        for p in res["unreferenced"]:
            print(f"    · {p}")
    print(f"  形状：被提到的 {len(res['referenced'])} 个端点里，"
          f"**{len(res['with_keyset'])} 个**附近 30 行内有键集断言（其余只被「打过」，形状未被钉）")
    print("  口径：referenced = 路径字面量在 server/src/*.test.ts 里出现过；")
    print("        它不表示响应形状被断言过（可能只断言了 401），也不覆盖模板串拼出来的调用。")
    if "--fail-on-unreferenced" in argv and res["unreferenced"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
