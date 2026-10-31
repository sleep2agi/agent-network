#!/usr/bin/env python3
"""`/tmp` 卫生：固定路径必须登记，未登记的固定路径一律红。

2026-10-31 —— 外部复核 (d)（原话）：
    「真实缺陷是给操作员建议了一个无权限的固定路径，而同仓两个脚本用的是
      `umask 077`/`chmod 600` ⇒ **两套卫生标准并存**（固定 /tmp 路径 47 处 vs mktemp 121 处）。」

固定 `/tmp` 路径的三种风险，按严重度：
  ① 并发：两个同名运行互相覆盖（CI 同机并行时最先炸）
  ② 预置：别人先建同名文件/软链 ⇒ 写进去的是他的目标
  ③ 残留：上一次的读数被当成这一次的（`>` 会截断，`>>` 不会）

本门的判据很窄：**scripts/ 里出现的每一个 /tmp 固定路径，都必须能在
KNOWN_FIXED_TMP 里找到一行理由**。理由只有两类：
  · `ci-artifact`：故意跨步骤读回（例如 qa.sh 的时间线表），同机并发靠「一次只跑一个」保证
  · `template`：带 XXXXXX，交给 mktemp 填

未登记 ⇒ 红。这样「又加了一个 /tmp/foo」不再是无声决定。

退出码：0 = 全部已登记 ｜ 1 = 有未登记 ｜ 2 = 扫描域为空（没有读数）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCAN_DIR = REPO / "scripts"
TMP = re.compile(r"/tmp/[A-Za-z0-9_.\-]*")

# 固定路径白名单：前缀（或完整路径）→ 理由
KNOWN_FIXED_TMP: dict[str, str] = {
    "/tmp/qa-l1-timing.tsv": "ci-artifact：qa.sh 写完、同一 job 的后续步骤 grep 'L1-TIMING'；不跨 job",
    "/tmp/qa-l1-prebuild.log": "ci-artifact：同一 job 内 build 失败时回读日志",
    "/tmp/qa-l1-registry-snapshot.txt": "ci-artifact：同一 job 内 npm 快照前后对照",
    "/tmp/qa-l1-": "ci-artifact 前缀：每个 L1 套件的 run 日志与工作目录，按套件名区分",
    "/tmp/qa-l0-": "ci-artifact 前缀：L0 每个用例的日志，按用例名区分",
    "/tmp/team-rules-artifact.XXXXXX": "template：XXXXXX 交给 mktemp 填，本身不是固定路径",
}


def scan() -> tuple[list[dict], int, int]:
    hits: list[dict] = []
    files = 0
    mktemp_uses = 0
    if not SCAN_DIR.is_dir():
        return hits, files, mktemp_uses
    for p in sorted(SCAN_DIR.rglob("*.sh")):
        files += 1
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            if line.lstrip().startswith("#"):
                continue
            if "mktemp" in line:
                mktemp_uses += 1
                # 同一行里的 mktemp 模板也记下来，后面统一判定
            for m in TMP.finditer(line):
                path = m.group(0).rstrip(".")
                if not path or path == "/tmp/":
                    continue
                hits.append({"file": str(p.relative_to(REPO)), "line": i, "path": path, "text": line.strip()[:120]})
    return hits, files, mktemp_uses


def allowed(path: str) -> str | None:
    if path in KNOWN_FIXED_TMP:
        return KNOWN_FIXED_TMP[path]
    for prefix, why in KNOWN_FIXED_TMP.items():
        if prefix.endswith("-") and path.startswith(prefix):
            return why
    return None


SELFTEST = [
    # (路径, 期望已登记?)
    ("/tmp/qa-l1-timing.tsv", True),
    ("/tmp/qa-l0-test123.log", True),
    ("/tmp/my-new-scratch.dat", False),
]


def selftest(quiet: bool = False) -> int:
    fails = 0
    for path, want in SELFTEST:
        got = allowed(path) is not None
        ok = got == want
        if not quiet:
            print(f"  {'✓' if ok else '✗'} 已登记={want} 实际={got}  {path}")
        fails += 0 if ok else 1
    if not quiet:
        print(f"  selftest: {len(SELFTEST) - fails}/{len(SELFTEST)} 通过")
        # 白名单本身也要非空，否则「全部已登记」是空话
        if not KNOWN_FIXED_TMP:
            print("  ✗ KNOWN_FIXED_TMP 为空 ⇒ 白名单失效")
            fails += 1
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    hits, files, mktemp_uses = scan()
    if files == 0:
        print("扫描域为空（scripts/ 下没有 .sh）⇒ 没有读数", file=sys.stderr)
        return 2
    unknown = [h for h in hits if allowed(h["path"]) is None]
    if "--json" in argv:
        print(json.dumps({
            "files": files, "mktemp_uses": mktemp_uses,
            "fixed_paths": len(hits), "unknown": unknown,
        }, ensure_ascii=False, indent=2))
        return 1 if unknown else 0
    print(f"扫描 {files} 个脚本：mktemp {mktemp_uses} 次 ｜ 固定 /tmp 路径 {len(hits)} 处"
          f"（已登记 {len(hits) - len(unknown)}，未登记 {len(unknown)}）")
    for h in unknown[:12]:
        print(f"    ✗ {h['file']}:{h['line']}  {h['path']}   {h['text']}")
    if unknown:
        print("  ⇒ 新固定路径要先回答并发/预置/残留三条："
              "能 mktemp 就 mktemp；确实要跨步骤读回，就登记进 KNOWN_FIXED_TMP 并写清为什么不冲突。",
              file=sys.stderr)
        return 1
    print("  ✓ 所有固定 /tmp 路径都已登记（理由见 KNOWN_FIXED_TMP）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
