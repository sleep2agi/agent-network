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

# 这些是**输入**（读取请求头），不是响应头生产者；本脚本只数写出点。
READ_CALL = re.compile(r"headers\.get\(\s*[\"']([A-Za-z0-9-]+)[\"']")


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


def main(argv: list[str]) -> int:
    got = scan()
    if got is None:
        print("扫描域为空 ⇒ 没有读数", file=sys.stderr)
        return 2
    producers, files = got
    multi = {k: v for k, v in producers.items() if len(set(v)) >= 2}
    single = {k: v for k, v in producers.items() if len(set(v)) == 1}

    if "--json" in argv:
        print(json.dumps({
            "instrument": "report-header-producers",
            "evidence_domain": "source",
            "counts": {"headers": len(producers), "single_producer": len(single),
                       "multi_producer": len(multi), "files_scanned": files},
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
    print("  口径：只数显式写出点；值是否一致不在这里体现（两处写同一个头、值不同也算 2 处）。")
    if "--fail-on-multi" in argv and multi:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
