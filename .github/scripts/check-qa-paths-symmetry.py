#!/usr/bin/env python3
"""qa.yml 的 pull_request.paths 与 push.paths 必须保持一致。

## 背景(#1062)

2026-08-27 按事件归属逐行解析 qa.yml:pull_request 150 条 / push 139 条,
差集单向 —— 仅 PR 有 11 条,仅 push 有 0 条。其中包括
tests/test1195-side-thread-hub-security/**(一道安全契约门)。

后果:改动这些目标,PR 上会触发门、合进 main 后不触发。
「这个改动在 main 上是好的」没有任何证据支持,而 PR 上的绿看起来完全正常。
#1243 同形状:deploy/** 只登记一半,一条 PR 检查数从 ~92 掉到 16
(比例反而更好看),main 红了约 6 小时没人看见。

差集单向说明这不是两边各自演化,而是「新增条目时只加 PR 段」的系统性习惯 ——
所以这道门存在的理由是:下一个只加一段的人,在 PR 上就被拦住。

## 判据

1. 按事件归属解析两段(不是数字符串出现次数 —— 同一行在两段各出现一次,
   grep -c 会数出 2 但无法区分它落在哪段)。
2. 两段差集必须为空,除非条目在豁免文件里。
3. 🔴 任一段解析出 0 条 → exit 2。零范围的对称检查和坏掉的解析器无法区分,
   拒绝通过(同 check-l1-sha-binding / gate 2 的立场)。
4. 🔴 豁免条目若已不构成任何不对称 → 红。过期豁免会静默扩大盲区
   (同 sync-pinned-versions 的 MISSING TARGET 立场:注册表脱节必须说话)。

## 豁免文件

.github/scripts/qa-paths-symmetry-exemptions.txt,每行一条 path(带引号原样),
# 开头为注释。2026-08-27 建门时差集已被 #1265 清零,所以豁免文件为空 ——
这道门不是"要求清零"型(那种门第一天就红):它建在零点上,只对新增不对称变红。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

QA = Path(".github/workflows/qa.yml")
EXEMPT = Path(".github/scripts/qa-paths-symmetry-exemptions.txt")


def parse_sections(text: str) -> dict[str, list[str]]:
    ev = None
    cur = None
    secs: dict[str, list[str]] = {}
    for line in text.splitlines():
        m = re.match(r"^  (pull_request|push):", line)
        if m:
            ev = m.group(1)
        if re.match(r"^\s*paths:", line) and ev:
            cur = ev
            secs.setdefault(cur, [])
            continue
        if cur:
            if re.match(r"^\s+- '", line):
                secs[cur].append(line.strip())
            elif line.strip() and not line.strip().startswith("#"):
                cur = None
    return secs


def load_exemptions() -> set[str]:
    if not EXEMPT.exists():
        return set()
    out = set()
    for line in EXEMPT.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line)
    return out


def run(qa_text: str, exemptions: set[str]) -> int:
    secs = parse_sections(qa_text)
    pr = secs.get("pull_request", [])
    push = secs.get("push", [])
    # 🔴 零范围 = 解析器坏了或结构变了,不是"没有不对称"。
    if not pr or not push:
        print(
            f"::error::qa.yml 解析出 pull_request={len(pr)} 条 / push={len(push)} 条 —— "
            "零范围的对称检查和坏掉的解析器无法区分,拒绝通过。"
        )
        return 2
    only_pr = [x for x in pr if x not in set(push)]
    only_push = [x for x in push if x not in set(pr)]
    problems = 0
    for entry in only_pr:
        if entry in exemptions:
            print(f"note: 豁免中的不对称(仅 PR): {entry}")
            continue
        print(
            f"::error::{entry} 只在 pull_request 段 —— 合进 main 后改动它不会重跑 qa。"
            "两段都加,或写进豁免文件并说明理由。"
        )
        problems += 1
    for entry in only_push:
        if entry in exemptions:
            print(f"note: 豁免中的不对称(仅 push): {entry}")
            continue
        print(
            f"::error::{entry} 只在 push 段 —— PR 上改动它不触发 qa,红会在合并后才出现。"
        )
        problems += 1
    # 🔴 过期豁免必须说话:它已不豁免任何东西,留着只会静默扩大未来盲区。
    live_asym = set(only_pr) | set(only_push)
    for ex in sorted(exemptions):
        if ex not in live_asym:
            print(
                f"::error::豁免条目已过期(不再构成不对称): {ex} —— 从豁免文件删掉它。"
            )
            problems += 1
    print(
        f"pull_request={len(pr)} push={len(push)} 仅PR={len(only_pr)} 仅push={len(only_push)} "
        f"豁免={len(exemptions)} problems={problems}"
    )
    if problems:
        return 1
    print("两段 paths 对称(或差异均在豁免内)。")
    return 0


def selftest() -> int:
    def qa(pr_paths: list[str], push_paths: list[str]) -> str:
        body = "on:\n  pull_request:\n    paths:\n"
        body += "".join(f"      - '{p}'\n" for p in pr_paths)
        body += "  push:\n    branches: [main]\n    paths:\n"
        body += "".join(f"      - '{p}'\n" for p in push_paths)
        body += "jobs:\n  x:\n    runs-on: ubuntu-latest\n"
        return body

    cases = [
        ("对称通过", qa(["a/**", "b/**"], ["a/**", "b/**"]), set(), 0),
        ("仅PR一条红", qa(["a/**", "b/**"], ["a/**"]), set(), 1),
        ("仅push一条红", qa(["a/**"], ["a/**", "c/**"]), set(), 1),
        ("豁免后通过", qa(["a/**", "b/**"], ["a/**"]), {"- 'b/**'"}, 0),
        ("过期豁免红", qa(["a/**"], ["a/**"]), {"- 'gone/**'"}, 1),
        ("零范围拒绝", "on:\n  pull_request:\njobs:\n", set(), 2),
    ]
    for name, text, ex, want in cases:
        got = run(text, ex)
        if got != want:
            print(f"selftest FAIL: {name}: want exit {want}, got {got}")
            return 1
        print(f"ok   {name}")
    print("selftest passed.")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    return run(QA.read_text(encoding="utf-8"), load_exemptions())


if __name__ == "__main__":
    raise SystemExit(main())
