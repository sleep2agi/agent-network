#!/usr/bin/env python3
"""响应头的**生产者计数** —— 一个头有几个地方在写它。

2026-10-31 起因（外部复核）：
    「一条断言先答『它保护的值有几个生产者』，再答『它保护的域有多大』。」
    他们那侧的同形：某个 location 有**两个** `Cache-Control` 生产者
    （`expires` 与 `add_header … always`），于是「改掉那个值」并不能改掉行为 —— 变成两处都要改。
    修法是**删生产者**，不是改值。

本脚本不判红，只回答一个问题：`server/src` 里每个响应头名，被几处写。
    1 处 ⇒ 单生产者：改它就是改行为
    ≥2 处 ⇒ 多生产者：改一处只是改了一部分，且**没有任何测试会因此变红**

用法：
    python3 scripts/report-header-producers.py           # 人读
    python3 scripts/report-header-producers.py --json
    python3 scripts/report-header-producers.py --fail-on-multi   # 有 ≥2 生产者 ⇒ exit 1

退出码：0 有读数；1 仅当 --fail-on-multi 且存在多生产者头；2 扫描域为空（没有读数）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCAN = REPO / "server" / "src"

# 两种写法都要认：
#   res.headers.set("X-Foo", …)        —— 命令式
#   headers: { "X-Foo": …, … }         —— 字面量对象（Response 构造时）
SET_CALL = re.compile(r"headers\.set\(\s*[\"']([A-Za-z0-9-]+)[\"']")
LITERAL_KEY = re.compile(r"[\"'](X-[A-Za-z0-9-]+|Cache-Control|Content-Type|ETag|Vary|Connection)[\"']\s*:")

# 路由锚：`url.pathname === "…"` 与 `.match(/^…/)`。
# 2026-10-31 —— **计数要按路由分组**：`content-type` 11 处里绝大多数属于**不同**路由，
# 那不是「一个值有 11 个生产者」，那是「11 个值各有 1 个生产者」。
# 真正的缺陷形态是：**同一条路由里同一个头写了两次**（他们那侧就是 expires + add_header）。
ROUTE_ANCHOR = re.compile(r'url\.pathname === "|url\.pathname\.match\(/\^')

# 这些是**输入**（读取请求头），不是响应头生产者；本脚本只数写出点。
READ_CALL = re.compile(r"headers\.get\(\s*[\"']([A-Za-z0-9-]+)[\"']")


def per_route_duplicates(text: str) -> list[str]:
    """同一路由块内、同一个头被写两次 ⇒ 返回 ["<route> :: <header> @ line,line"]。"""
    lines = text.splitlines()
    anchors = [(i, l.strip()) for i, l in enumerate(lines) if ROUTE_ANCHOR.search(l)]

    # 函数锚：没有路由锚的文件（helper 模块）按**函数**分组。
    # 否则 `streamResponse` 的 Cache-Control 与 `json()` 的 Cache-Control 会被算成同一处两次 ——
    # 那是两个不同的响应构造器，不是同一路由内的两个生产者（实测踩到过这个假阳）。
    FUNC_ANCHOR = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=\s*(?:async\s*)?\(")

    def route_of(idx: int) -> str:
        best = "(文件顶层)"
        best_i = -1
        for i, l in anchors:
            if i <= idx and i > best_i:
                best, best_i = l[:70], i
        if best_i >= 0:
            # 路由锚与函数锚取**更近**的那个：路由块内部再分函数会把一处写拆成两处
            return best
        for i, line in enumerate(lines[: idx + 1]):
            m = FUNC_ANCHOR.match(line)
            if m:
                best, best_i = f"fn:{m.group(1) or m.group(2)}", i
        return best

    buckets: dict[tuple[str, str], list[int]] = {}
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        if READ_CALL.search(line):
            line = READ_CALL.sub("", line)
        for m in SET_CALL.finditer(line):
            buckets.setdefault((route_of(i), m.group(1).lower()), []).append(i + 1)
        for m in LITERAL_KEY.finditer(line):
            buckets.setdefault((route_of(i), m.group(1).lower()), []).append(i + 1)
    out: list[str] = []
    for (route, name), at in buckets.items():
        if len(set(at)) >= 2:
            out.append(f"{route} :: {name} @ {','.join(str(x) for x in sorted(set(at)))}")
    return out


def scan() -> tuple[dict[str, list[str]], int] | None:
    files = sorted(p for p in SCAN.glob("*.ts") if not p.name.endswith(".test.ts"))
    if not files:
        return None
    producers: dict[str, list[str]] = {}
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # 先抹掉读请求头的地方，避免把 `headers.get("X")` 当成生产者
        body = READ_CALL.sub("", text)
        for i, line in enumerate(body.splitlines(), 1):
            stripped = line.lstrip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue        # 注释里的头名不是生产者（与「注释不是 runner」同一条）
            for name in SET_CALL.findall(line):
                producers.setdefault(name.lower(), []).append(f"{p.name}:{i}")
            for name in LITERAL_KEY.findall(line):
                producers.setdefault(name.lower(), []).append(f"{p.name}:{i}")
    return producers, len(files)


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
    got = scan()
    if got is None:
        print("扫描域为空 ⇒ 没有读数", file=sys.stderr)
        return 2
    producers, files = got
    # 按路由分组的重复（这才是缺陷形态；跨路由的同名头是正常的）
    route_dups: list[str] = []
    for p in sorted(SCAN.glob("*.ts")):
        if p.name.endswith(".test.ts"):
            continue
        try:
            route_dups.extend(per_route_duplicates(p.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            continue

    multi = {k: v for k, v in producers.items() if len(set(v)) >= 2}
    single = {k: v for k, v in producers.items() if len(set(v)) == 1}

    if "--json" in argv:
        print(json.dumps({
            "instrument": "report-header-producers",
            "measured_by": _measured_by(),
            "evidence_domain": "source",
            "counts": {"headers": len(producers), "single_producer": len(single),
                       "multi_producer": len(multi), "files_scanned": files,
                       "routes_with_duplicate_header": len(route_dups)},
            "route_duplicates": route_dups,
            "multi": {k: sorted(set(v)) for k, v in sorted(multi.items())},
            "covers": "server/src 里显式写出响应头的地方（headers.set 与字面量对象）",
            "does_not_cover": [
                "间接写出（例如框架/中间件代发）",
                "值是否一致（两处写同一个头，值不同也不会在这里体现）",
            ],
        }, ensure_ascii=False, indent=2))
        return 1 if ("--fail-on-multi" in argv and multi) else 0

    print(f"HEADER-PRODUCERS v1 files={files} headers={len(producers)} "
          f"single={len(single)} multi={len(multi)}")
    for k, v in sorted(multi.items(), key=lambda kv: -len(set(kv[1]))):
        print(f"  ⚠ {k}: {len(set(v))} 处 —— {', '.join(sorted(set(v)))}")
    print(f"同一路由内同名头写出点 >1：{len(route_dups)} 处（这才是缺陷形态）")
    for d in route_dups[:10]:
        print(f"  ⚠ {d}")
    print("  口径：全局计数把「不同路由各有 1 个」也数进去了；判断缺陷请看上面这一行。")
    if "--fail-on-multi" in argv and multi:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
