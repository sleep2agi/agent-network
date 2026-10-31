#!/usr/bin/env python3
"""把 `bun test` 的失败按**根因**归并 —— 「失败 N 条」不是一个待修的数量。

2026-10-31 起因（外部复核，两边的同一课）：
    逐文件跑（每文件一个新 COMMHUB_DB）⇒ 93 pass / 0 fail
    单进程跑全量（共享 db）        ⇒ 812 fail
    ⇒ 同一个 commit、同一批测试、两个结果 —— 差别在**隔离粒度**。

812 不是 812 个缺陷，它是**一次没有归并的输出**；按条排队修它，永远修不完。
本脚本把失败按「最近一条 error: 的签名」归并，输出「N 条 ⇒ M 个根因」。

用法：
    bun test 2>&1 | python3 scripts/summarize-test-failures.py
    python3 scripts/summarize-test-failures.py --file log.txt
    python3 scripts/summarize-test-failures.py --json

退出码：0 有输出且至少归并了一组 ｜ 2 没有读到任何失败（**没有读数**，不是「全绿」）。
    ⚠️ 0 不等于「测试通过」：这个脚本只读失败。要判断绿，请看 runner 的退出码。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FAIL = re.compile(r"^\s*\(fail\)\s+(?P<name>.+?)\s*(\[\d+(?:\.\d+)?ms\])?\s*$")
ERR = re.compile(r"^\s*(?:error|Error|✗)?:?\s*(?P<sig>.{8,})$")
# bun 的 error 行形状多变：`error: expect(received).toBe(expected)`、`TypeError: ...`
SIG = re.compile(r"^\s*(?:(?:error|Error)\b:?\s*)?(?P<sig>[A-Za-z_.$][\w.$]*(?:Error|Exception)\b.*|expect\(.*|.*\bto(?:Be|Equal|Match|Contain|Throw)\b.*)$")


def summarize(text: str) -> dict:
    groups: dict[str, list[str]] = {}
    current = "(无签名)"
    pending: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        m = FAIL.match(line)
        if m:
            # ⚠️ 这里**不重置** current：一条 error 之后常跟多条 `(fail)`（连锁失败），
            # 重置会把同一根因拆成多个「无签名」组 —— 而那正是这次事故的形状。
            groups.setdefault(current, []).append(m.group("name"))
            continue
        s = SIG.match(line)
        if s:
            current = s.group("sig").strip()[:120]
            pending.clear()
            continue
    total = sum(len(v) for v in groups.values())
    return {
        "failures": total,
        "causes": len(groups) if total else 0,
        "groups": {k: v for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))},
    }


def main(argv: list[str]) -> int:
    if "--file" in argv:
        p = Path(argv[argv.index("--file") + 1])
        text = p.read_text(encoding="utf-8", errors="replace")
    else:
        text = sys.stdin.read()

    res = summarize(text)
    if res["failures"] == 0:
        print("没有读到任何 (fail) 行 ⇒ **没有读数**（不是「全绿」）", file=sys.stderr)
        return 2

    if "--json" in argv:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    print(f"失败 {res['failures']} 条 ⇒ 归并后 **{res['causes']} 个根因**")
    for sig, names in res["groups"].items():
        print(f"  · x{len(names)}  {sig}")
        print(f"      首条：{names[0]}")
    print("  ⇒ 按条修 812 次，不如先确认它们是不是 1 个根因；隔离粒度（命令 + 每文件新 DB）是结论的一半。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
