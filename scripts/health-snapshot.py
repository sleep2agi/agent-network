#!/usr/bin/env python3
"""今日全绿口径 —— 一条命令给出「哪些层过了、哪些层**没有读数**」。

2026-10-31 起因（卡 #3235）：
    qa.sh --l0 打「ALL PASS in 5s (scope: L0)」，而**L1 根本没跑**；
    16 个 check-*.py 里 15 个 exit=0、1 个 exit=2（argparse 缺必填参数 = 没有读数）。
    ⇒ 三件事在报告上长得一样：「通过」「没跑」「跑不起来」。
    而人只看得见「全绿」这两个字。

本脚本把三态写死：
    pass       exit 0        ⇒ 这一层真的查过且通过
    fail       exit 1        ⇒ 查到了问题
    no-reading exit 2 / 其它 ⇒ **没有读数**（不读作通过，也不读作失败）
    not-run    （未执行）    ⇒ 与 no-reading 分开：后者跑了但说不出话，前者根本没跑

用法：
    python3 scripts/health-snapshot.py            # 人读（逐层）
    python3 scripts/health-snapshot.py --json     # 机器读
    python3 scripts/health-snapshot.py --skip-l0  # 只跑门（L0 约 5s，可以省）

退出码：0 全部 pass ｜ 1 有 fail ｜ 2 有 no-reading / not-run（**没有读数**）。
    注意 0 与 2 的区别：2 不是失败，但它也**不是绿**。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GATES_DIR = REPO / "scripts"
DEFAULT_TIMEOUT = 300

# 需要额外参数才能跑的门（没有参数时 exit=2 = 没有读数，不是失败）。
# 这里登记它们「怎么跑」，而不是永远把它们记成 no-reading：
#   一条永远记成「没读数」的条目，等于把那一层从巡检里删掉。
GATE_ARGS: dict[str, list[str]] = {}

# 需要**外部输入**才能跑的门：巡检不提供输入时，它们是「未运行」，不是「没有读数」。
# 2026-10-31 —— 第一版把 check-claim-existence 记成 no-reading，读起来像「这个门坏了」；
# 实际是它要一个报告文件（卡/文档全文）当输入，而巡检没给。
# ⇒ 「我这次没喂它」与「它喂了也说不出话」是两件事，报告要分开。
NEEDS_INPUT: dict[str, str] = {
    "check-claim-existence.py": "需要一个报告/卡全文作为输入（把里面的反引号标识符逐个 grep）",
}


def classify(rc: int) -> str:
    """退出码 → 三态。这一条就是整份巡检的判据，所以它必须能被自检。"""
    if rc == 0:
        return "pass"
    if rc == 1:
        return "fail"
    return "no-reading"


def run(cmd: list[str], timeout: int) -> tuple[int, str]:
    try:
        res = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=timeout)
        return res.returncode, (res.stdout or "") + (res.stderr or "")
    except subprocess.TimeoutExpired:
        # 超时不是失败：它没有告诉你任何关于代码的事。
        return 2, f"timeout after {timeout}s"
    except Exception as exc:  # noqa: BLE001
        return 2, f"runner error: {exc}"


def gates(timeout: int) -> list[dict]:
    out: list[dict] = []
    for p in sorted(GATES_DIR.glob("check-*.py")):
        if p.name in NEEDS_INPUT:
            # 2026-10-31 —— 「这次没喂输入」与「它不会红」是两件事。
            # 前者是 not-run（状态），后者是能力问题（can_go_red）。
            # 原来这里直接 continue ⇒ 需要输入的门被记成「不能证明会红」，
            # 而它其实有 --selftest、只是不依赖那份输入。
            interp_nei = {"": [sys.executable], ".py": [sys.executable], ".sh": ["bash"], ".mjs": ["node"]}.get(
                p.suffix, [sys.executable])
            self_rc_nei, _ = run(interp_nei + [str(p.relative_to(REPO)), "--selftest"], timeout)
            out.append({"layer": "gate", "name": p.name, "exit": None, "state": "not-run",
                        "detail": f"未运行：{NEEDS_INPUT[p.name]}", "can_go_red": self_rc_nei == 0})
            continue
        args = [sys.executable, str(p.relative_to(REPO))] + GATE_ARGS.get(p.name, [])
        rc, txt = run(args, timeout)
        # 另一个问题：**它会不会红**（能力），与「今天红不红」（现状）无关。
        # 对 .sh/.mjs 用对应解释器（元门里也踩过同一个坑）。
        interp = {"": [sys.executable], ".py": [sys.executable], ".sh": ["bash"], ".mjs": ["node"]}.get(p.suffix, [sys.executable])
        self_rc, _ = run(interp + [str(p.relative_to(REPO)), "--selftest"], timeout)
        state = classify(rc)
        detail = ""
        if state != "pass":
            lines = [l.strip() for l in txt.splitlines() if l.strip()]
            detail = (lines[0] if lines else "")[:160]
        out.append({"layer": "gate", "name": p.name, "exit": rc, "state": state, "detail": detail,
                    "can_go_red": self_rc == 0})
    return out


def l0(timeout: int) -> dict:
    rc, txt = run(["bash", "scripts/qa.sh", "--l0"], timeout)
    state = classify(rc)
    tail = [l.strip() for l in txt.splitlines() if l.strip()][-1:] or [""]
    return {"layer": "L0", "name": "qa.sh --l0", "exit": rc, "state": state, "detail": tail[0][:160]}


# 明确**没有跑**的层。把「没跑」写成条目，而不是让读者从沉默里推断。
NOT_RUN = [
    {"layer": "L1", "name": "qa.sh（默认，含 L1）", "state": "not-run",
     "detail": "需要 docker；本机不可用 ⇒ 这一层今天没有读数，上面的绿不覆盖它"},
]


def selftest(quiet: bool = False) -> int:
    cases = [(0, "pass"), (1, "fail"), (2, "no-reading"), (3, "no-reading"), (None, "no-reading")]
    fails = 0
    for rc, want in cases:
        got = classify(rc if rc is not None else 2)
        ok = got == want
        fails += 0 if ok else 1
        if not quiet:
            print(f"  {'✓' if ok else '✗'} exit={rc} ⇒ {got}（期望 {want}）")
    if not quiet:
        print(f"  selftest: {len(cases) - fails}/{len(cases)} 通过")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2

    rows = gates(DEFAULT_TIMEOUT)
    if "--skip-l0" not in argv:
        rows.append(l0(DEFAULT_TIMEOUT))
    else:
        rows.append({"layer": "L0", "name": "qa.sh --l0", "state": "not-run",
                     "detail": "本次用 --skip-l0 跳过 ⇒ 这一层没有读数"})
    rows.extend(NOT_RUN)

    from collections import Counter
    c = Counter(r["state"] for r in rows)
    if "--json" in argv:
        print(json.dumps({
            "rows": rows,
            "by_state": dict(c),
            "scope": "check-*.py（全部）+ L0 + L1(未跑)",
            "reading": "只有 state=pass 的层是绿的；no-reading/not-run 都不构成绿",
        }, ensure_ascii=False, indent=2))
        return 1 if c.get("fail") else (2 if (c.get("no-reading") or c.get("not-run")) else 0)

    # 2026-10-31 —— **「能红」与「今天不红」是两条要求，必须并排说**（外部复核 ④：
    # 「门必须『能红』（变异测试证明）且『今天不红』（基线证明）；
    #   混为一谈会造出两种坏门：没有 must-fire 的门，和恒红的门。」）
    # 本脚本此前只回答后者；前者由 check-gates-wired 的「自检实跑」回答 —— 两条来自**不同工具**，
    # 读者不会自己去对。把两者放进同一段输出里，才看得出「今天绿」是哪种绿。
    print(f"对象：scripts/check-*.py {sum(1 for r in rows if r['layer'] == 'gate')} 个 + L0 + L1")
    gate_rows = [r for r in rows if r["layer"] == "gate"]
    can_go_red = sum(1 for r in gate_rows if r.get("can_go_red"))
    print(f"  能红（--selftest 实跑成功）  : {can_go_red}/{len(gate_rows)}"
          f"（没有这一项的门即使今天绿，也只是『没查』）")
    print(f"  今天不红（本次 exit=0）      : {sum(1 for r in gate_rows if r['state'] == 'pass')}/{len(gate_rows)}")
    for state, label in (("pass", "通过"), ("fail", "失败"), ("no-reading", "**没有读数**"), ("not-run", "**未运行**")):
        n = c.get(state, 0)
        if n:
            print(f"  {label}: {n}")
    bad = [r for r in rows if r["state"] in ("fail", "no-reading", "not-run")]
    if bad:
        print("\n不构成「绿」的层：")
        for r in bad:
            print(f"  · [{r['state']}] {r['layer']} {r['name']}  {r['detail']}")
    if c.get("fail"):
        return 1
    if bad:
        print("\n⇒ 这不是「全绿」：有层没有读数。要说全绿，必须先让每一层都给出 pass。", file=sys.stderr)
        return 2
    print("\n✓ 每一层都是 pass（scope 见上）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
