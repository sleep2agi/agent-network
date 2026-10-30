#!/usr/bin/env python3
"""`reason` 被当成 code 用了几处 —— 把它们列出来，并**冻结**成棘轮。

2026-10-31 —— 起因（外部复核，原话）：
    code   = 机器契约（脚本 case 分支只认它）
    reason = 散文（人读的定位信息，措辞会变，不该被脚本依赖）
    ⇒ 「别让同一个区分同时住在 code 和 reason 里」

本仓现状：有一批 `x.reason === "字面量"` —— 也就是**脚本在按散文分支**。
它们不一定错（那些 reason 事实上是枚举），但它们**没有被声明成枚举**：

  · 有人把措辞从 `mode_readonly` 改成 `readonly mode` ⇒ 分支静默失效，类型系统不拦
  · 而「分支失效」的表现是「这个判断永远为假」—— 与「确实不该拦」同形

⇒ 本脚本不做判定，只做两件事：
    ① 把当前的 N 处列出来（带文件:行 与上下文），让「散文被当契约」这件事可见
    ② 冻结成棘轮：新增一处就红 —— 新代码要按 reason 分支，必须在这里显式登记并说明为什么

用法：python3 scripts/report-reason-branches.py [--assert] [--json]
退出码：0 = 没有新增；1 = 新增了未登记的按散文分支；2 = 扫描域为空。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BRANCH = re.compile(r"\.reason\s*[!=]==?\s*\"([^\"]+)\"")
SCAN_ROOTS = ["server/src", "agent-node/src", "agent-network/src"]

# 已登记的「按散文分支」。**每一行都是一次显式决定**：这些 reason 事实上是枚举。
# 新增条目要有理由：为什么不能加一个 code 字段。
KNOWN: set[str] = {
    'agent-network/src/codex-copresence-rpc.ts::string',
    'agent-network/src/codex-login-share-guard.ts::missing',
    'agent-network/src/node-delete-hub.ts::no-hub',
    'agent-node/src/cli.ts::empty vendor result despite success signal',
    'agent-node/src/cli.ts::empty_sessions',
    'agent-node/src/cli.ts::no_sessions_field',
    'agent-node/src/cli.ts::self_only',
    'agent-node/src/runtime/opencode-start-completion.ts::TUI session mismatch',
    'agent-node/src/runtime/restart-intent.ts::string',
    'server/src/inbox-caller.ts::not_a_node_token',
    'server/src/node-permissions.ts::not_a_node_token',
    'server/src/rest-identity.ts::not_a_node_token',
    'server/src/runtime-readiness.ts::string',
    'server/src/scheduled-failures.ts::paused',
    'server/src/scheduled-stuck.ts::stuck',
    'server/src/server.ts::not_a_node_token',
    'server/src/team-rules-status.ts::string',
    'server/src/tool-audience.ts::mode_readonly',
    'server/src/tool-audience.ts::mode_restricted_not_assigned',
    'server/src/tools.ts::identity_mismatch',
    'server/src/tools.ts::string',
}

# 上面这份是**冻结的现状**（file::value），不是「批准」。
# 它挡的是「新增」：以后谁要按 reason 分支，必须在这里加一行 —— 那一刻就是他做决定的那一刻。
_PROSE_NOTE = "值里带空格 ⇒ 几乎肯定是散文（如 \"empty vendor result despite success signal\"）：分支随措辞改而静默失效"

ALLOWLIST: dict[str, str] = {
    "server/src/tool-audience.ts": "鉴权拒绝原因；值是内部枚举（mode_readonly / mode_restricted_not_assigned），未导出成类型",
    "server/src/scheduled-failures.ts": "调度失败原因；由本仓写入、本仓读取，值域封闭但没写成枚举",
    "server/src/tools.ts": "team rules upsert 的拒绝原因（identity_mismatch）；同一处产出、同一处消费",
}


def tracked(roots: list[str]) -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files", *[f"{r}/*.ts" for r in roots]],
                             cwd=REPO, capture_output=True, text=True, timeout=60).stdout
        files = [REPO / line for line in out.split("\n") if line.strip()]
    except Exception:  # noqa: BLE001
        files = [p for r in roots for p in (REPO / r).rglob("*.ts")]
    return [p for p in files if not p.name.endswith(".test.ts") and p.exists()]


def scan() -> list[dict]:
    hits: list[dict] = []
    for p in tracked(SCAN_ROOTS):
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        rel = str(p.relative_to(REPO))
        for i, line in enumerate(lines, 1):
            if line.lstrip().startswith("//") or line.lstrip().startswith("*"):
                continue
            for m in BRANCH.finditer(line):
                hits.append({"file": rel, "line": i, "value": m.group(1), "text": line.strip()[:120]})
    return hits


def main() -> int:
    hits = scan()
    if not hits:
        print("扫描域为空：没有扫到任何 .ts ⇒ 没有读数（不是「0 处」）", file=sys.stderr)
        return 2
    files = sorted({h["file"] for h in hits})
    unregistered = [h for h in hits if h["file"] not in ALLOWLIST]
    stale = sorted(f for f in ALLOWLIST if f not in files)

    if "--json" in sys.argv:
        print(json.dumps({"object": SCAN_ROOTS, "hits": hits, "unregistered": unregistered,
                          "stale_allowlist": stale}, ensure_ascii=False, indent=2))
        return 1 if unregistered else 0

    print(f"对象：{', '.join(SCAN_ROOTS)}（git ls-files，不含 *.test.ts）")
    print(f"`.reason` 被按字面量分支：**{len(hits)} 处**，分布在 {len(files)} 个文件")
    print()
    for f in files:
        note = ALLOWLIST.get(f)
        mark = "✓" if note else "✗"
        print(f"  {mark} {f}")
        if note:
            print(f"      登记理由：{note}")
        for h in [x for x in hits if x["file"] == f][:3]:
            prose = " " in h["value"]
            print(f"      :{h['line']}  {h['text']}{'   ⚠ 散文当 code' if prose else ''}")
    if stale:
        print("\n登记项已失效（文件里不再按 reason 分支，或文件没了）⇒ 删掉那一行：")
        for f in stale:
            print(f"  · {f}")
    print()
    print("判据：code 是机器契约，reason 是散文；同一个区分不该同时住在两边。")
    print("      这些文件里的 reason 事实上是枚举 —— 登记的意思是「我们知道，且暂不改」。")
    print("check: 重跑本脚本；新增文件或新增一处 ⇒ 未登记清单非空 ⇒ --assert 红。")

    new = [h for h in hits if f"{h['file']}::{h['value']}" not in KNOWN]
    gone = sorted(KNOWN - {f"{h['file']}::{h['value']}" for h in hits})
    print(f"  冻结基线：{len(KNOWN)} 条 file::value；本次新增 {len(new)} 条，消失 {len(gone)} 条")
    if "--assert" in sys.argv and (new or gone):
        if new:
            print(f"\n✗ {len(new)} 处新的「按 reason 分支」不在冻结基线里：", file=sys.stderr)
            for h in new[:10]:
                print(f"    · {h['file']}:{h['line']}  reason == \"{h['value']}\"", file=sys.stderr)
            print("  ⇒ 要么加一个 code 字段（推荐），要么把这一行加进 KNOWN 并说明理由。", file=sys.stderr)
        if gone:
            print(f"\n· {len(gone)} 条基线条目已消失（好事）：{', '.join(gone[:5])}", file=sys.stderr)
            print("  ⇒ 删掉基线里对应的行，让基线保持「当下」。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
