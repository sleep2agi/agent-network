#!/usr/bin/env python3
"""「看起来是测试，但没有任何 runner 会跑它」—— 一份确定性清单。

2026-10-31 —— 起因（外部复核，原话）：
    某文件在 `.sh/.mts/.mjs/.json` 里一处都没被引用，而 `npm test` 的 glob 是
    `test/*.test.ts` —— **确定不跑**，不是「大概率不跑」。
    ⇒ 「确定不跑」与「跑过但失败」在报告上同形（都没有那条结果）。

本脚本的口径只有一条：**名字像测试的 tracked 文件，必须落进某一类有据可查的执行者**：
    A. 我们的测试清单（`*.test.ts`，由 check-test-inventory.py 数着）
    B. 某个 runner 的 glob / 服务（workflow、compose、package.json、qa.sh、pytest 配置）
    C. 显式登记为「不跑」并写明为什么（比如只给手工/容器环境用）

既不在 A 也不在 B、又没有 C 的 ⇒ 报出来。它不判红：这类文件可能是给人手动跑的。

用法：python3 scripts/report-orphan-tests.py [--json]
退出码：0 = 没有「未归属」的；1 = 有；2 = 扫描域为空。
"""
from __future__ import annotations

import json
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOOKS_LIKE_TEST = re.compile(
    r"(\.(test|spec|pw)\.(ts|tsx|mjs|cjs|js)$)"
    r"|(^|/)test_[^/]*\.py$"
    r"|(_test\.py$)"
)
# 执行者：任何这些文件里提到候选文件名 ⇒ 有据可查
RUNNER_FILES_GLOBS = [
    ".github/workflows/*.yml", ".github/workflows/*.yaml",
    "**/package.json", "**/docker-compose.yml", "**/Dockerfile*",
    "scripts/qa.sh", "**/pytest.ini", "**/pyproject.toml", "**/Makefile",
]
# C 类登记：确实不跑，且知道为什么。
NOT_RUN_BY_DESIGN: dict[str, str] = {
    # 2026-10-31 —— 两条都是「能跑，但没有任何自动入口」。
    # 登记的意思是**当下这个事实**，不是「批准」；移出条件写在这里，到期就该删。
    "docs-site/scripts/desktop-update-dynamic.test.mjs":
        "docs-site 的 test:* 脚本都是手工跑；CI 里没有一步调 npm run test:*"
        "（移出条件：docs-site-build.yml 加一步 npm run test:update-dynamic）",
    "scripts/check-pair-published.test.mjs":
        "bun 单测放在 scripts/ 下，而 qa.sh 的 L0 只遍历三个包目录（server/agent-node/agent-network）"
        "（移出条件：把 scripts/*.test.mjs 纳入 L0_TESTS 或单列一步）",
}


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True, timeout=60).stdout
    return [l for l in out.split("\n") if l.strip()]


def main() -> int:
    files = tracked()
    if not files:
        print("扫描域为空：git ls-files 没有结果 ⇒ 没有读数", file=sys.stderr)
        return 2
    cands = [f for f in files if LOOKS_LIKE_TEST.search(f)]
    if not cands:
        print("扫描域为空：一个像测试的文件都没有 ⇒ 没有读数", file=sys.stderr)
        return 2

    runner_text: list[tuple[str, str]] = []
    for pat in RUNNER_FILES_GLOBS:
        for p in REPO.glob(pat):
            if not p.is_file() or "node_modules" in p.parts:
                continue
            try:
                body = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            # 2026-10-31 —— **注释不是 runner**。
            # 实测：我在 workflow 里写了一行注释 `*.test.mjs`，本脚本就把两个孤儿测试
            # 判成「有 runner 覆盖」⇒ 守卫的登记表失效、而输出仍然全绿。
            # ⇒ YAML 去掉行注释；package.json 只取 scripts 的值。
            if p.suffix in (".yml", ".yaml"):
                body = "\n".join(
                    ln.split(" #")[0] if not ln.lstrip().startswith("#") else ""
                    for ln in body.splitlines()
                )
            elif p.name == "package.json":
                try:
                    import json as _json
                    body = "\n".join(str(v) for v in (_json.loads(body).get("scripts") or {}).values())
                except Exception:  # noqa: BLE001
                    body = ""
            runner_text.append((str(p.relative_to(REPO)), body))
    if not runner_text:
        print("扫描域为空：没找到任何 runner 配置 ⇒ 没有读数（不是「都没有执行者」）", file=sys.stderr)
        return 2

    rows = []
    for f in cands:
        name = f.split("/")[-1]
        if f.endswith(".test.ts"):
            rows.append({"file": f, "verdict": "A_inventory", "why": "*.test.ts 由 check-test-inventory.py 计数"})
            continue
        # 2026-10-31 —— 「被引用」有三种形态，只认第一种会误报：
        #   ① 点名文件：body 里出现文件名
        #   ② **glob**：`node --test test/*.test.mjs` / `bun test scripts/*.test.mjs`
        #      —— 文件没被点名，但它真的会被跑（我第一版漏了这一种，误报了 2 个）
        #   ③ 路径点名
        referenced = [r for r, body in runner_text if name in body or f in body]
        if not referenced:
            for r, body in runner_text:
                for pat in re.findall(r"[\w./*-]*\*(?:\.test\.\w+|/\*\.test\.\w+)[\w./*-]*", body):
                    if fnmatch.fnmatch(f, pat) or fnmatch.fnmatch(f, "*/" + pat.lstrip("./")):
                        referenced.append(r)
                        break
                if referenced:
                    break
        if referenced:
            rows.append({"file": f, "verdict": "B_runner", "why": ", ".join(sorted(set(referenced))[:3])})
        elif f in NOT_RUN_BY_DESIGN:
            rows.append({"file": f, "verdict": "C_by_design", "why": NOT_RUN_BY_DESIGN[f]})
        else:
            rows.append({"file": f, "verdict": "ORPHAN", "why": "没有任何 runner 提到它"})

    inv_count = sum(1 for r in rows if r["verdict"] == "A_inventory")
    if inv_count == 0:
        # 2026-10-31 —— 阳性对照：本仓有 800+ 条 *.test.ts。若一条都没有，说明
        # LOOKS_LIKE_TEST 或 tracked() 坏了 ⇒ 此时「未归属 0」不是结论。
        print("✗ 阳性对照失败：一个 *.test.ts 都没识别到 ⇒ 判据可能坏了，"
              "此时「未归属 0」不能读成「都有人跑」", file=sys.stderr)
        return 2
    orphans = [r for r in rows if r["verdict"] == "ORPHAN"]
    if "--json" in sys.argv:
        print(json.dumps({"object": "git ls-files ∩ 名字像测试", "total": len(rows),
                          "by_verdict": {v: sum(1 for r in rows if r["verdict"] == v)
                                         for v in ("A_inventory", "B_runner", "C_by_design", "ORPHAN")},
                          "orphans": orphans}, ensure_ascii=False, indent=2))
        return 1 if orphans else 0

    print(f"对象：git ls-files ∩ 名字像测试 ⇒ {len(rows)} 个文件")
    for v, label in (("A_inventory", "A 测试清单计数"), ("B_runner", "B 有 runner 引用"),
                     ("C_by_design", "C 登记为不跑"), ("ORPHAN", "**未归属**")):
        n = sum(1 for r in rows if r["verdict"] == v)
        print(f"  {label}: {n}")
    if orphans:
        print("\n⚠ 这些文件**没有任何 runner 会跑它**（不是「跑失败了」，是「不会跑」）：", file=sys.stderr)
        for r in orphans:
            print(f"    · {r['file']}", file=sys.stderr)
        print("  ⇒ 处置只有两条：接进某个 runner，或登记进 NOT_RUN_BY_DESIGN 并写明为什么。", file=sys.stderr)
    print("check  : 重跑本脚本；新增「名字像测试」但没接 runner 的文件会出现在未归属里。")
    return 1 if orphans else 0


if __name__ == "__main__":
    sys.exit(main())
