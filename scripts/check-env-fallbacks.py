#!/usr/bin/env python3
"""`process.env.A || process.env.B` —— 跨变量回退必须登记「同概念」，否则就是错借。

2026-10-31 —— 外部复核 (d)（原话）：
    「错借已被写进合同；今天恰好正确，所以看不见；
      可 grep 形式是『一个初始化里两个不同 `process.env.X` 即错借』。」

为什么这条重要：`A ?? B` 在**类型上永远成立**（两个字符串），所以类型检查、lint、
甚至单测都不会响。它错的不是类型，是**语义**：
    `publicOrigin ?? 飞书回调的 origin` —— 一个是「本服务地址」，一个是「另一个子系统的回调地址」，
    同类型、不同概念；今天两个值恰好相等，于是看不见；哪天它们不等，就会静默借错值。

本门只做一件事：把仓库里**所有**跨 env 回退列出来，每条必须登记它是
`alias`（同一概念的别名，可换）还是 `borrow`（不同概念，禁止）。
    · 未登记的 ⇒ 红（新加的跨变量回退必须回答「是不是同一个概念」）
    · 登记为 borrow ⇒ 红（本仓不允许；若确实需要，先改成显式判空）

退出码：0 = 全部已登记为 alias ｜ 1 = 有未登记或 borrow ｜ 2 = 扫描域为空（没有读数）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCAN = ("*.ts",)
EXCLUDE_PARTS = ("node_modules", "dist", "fixtures", ".worktrees")

# 跨 env 回退：(A, B) —— A 缺失时借 B。
PAIR = re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)\s*(?:\?\?|\|\|)\s*process\.env\.([A-Z][A-Z0-9_]*)")

# 已登记：两个变量是**同一个概念**的不同名字（历史遗留 / 兼容期双名）
KNOWN_ALIAS: dict[tuple[str, str], str] = {
    ("COMMHUB_URL", "ANET_HUB_URL"): "hub 地址的旧名/新名（兼容期并存）",
    ("HOME", "USERPROFILE"): "家目录：POSIX 与 Windows 的不同名字",
    ("COMMHUB_RESUME_ID", "CLAUDE_RESUME_ID"): "会话恢复 id 的旧名/新名",
    ("COMMHUB_TOKEN", "AUTH_TOKEN"): "节点令牌的旧名/新名（stdio 上传工具内）",
    ("ANET_UPLOAD_ALIAS", "COMMHUB_ALIAS"): "别名的新名/旧名",
    ("OPENAI_BASE_URL", "OPENAI_API_BASE"): "同一端点变量的两种社区写法",
    ("OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"): "测试夹具里的旧名/新名",
}
# 明确判定为「不同概念」的（出现即红）。空 = 本仓目前没有。
KNOWN_BORROW: dict[tuple[str, str], str] = {}


def tracked() -> list[Path]:
    out = subprocess.run(["git", "ls-files", *SCAN], cwd=REPO, capture_output=True, text=True, timeout=60).stdout
    files = []
    for line in out.splitlines():
        if not line.strip() or line.endswith(".test.ts"):
            continue
        if any(part in line for part in EXCLUDE_PARTS):
            continue
        files.append(REPO / line)
    return files


def scan() -> tuple[list[dict], int]:
    hits, files = [], 0
    for p in tracked():
        if not p.exists():
            continue
        files += 1
        for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if line.lstrip().startswith("//"):
                continue
            for m in PAIR.finditer(line):
                hits.append({"file": str(p.relative_to(REPO)), "line": i, "a": m.group(1), "b": m.group(2),
                             "text": line.strip()[:120]})
    return hits, files


SELFTEST = [
    ("process.env.AAA || process.env.BBB", ("AAA", "BBB")),
    ("const x = process.env.CCC ?? process.env.DDD ?? ''", ("CCC", "DDD")),
    ("process.env.ONLY_ONE", None),
]


def selftest(quiet: bool = False) -> int:
    fails = 0
    for src, want in SELFTEST:
        m = PAIR.search(src)
        got = (m.group(1), m.group(2)) if m else None
        ok = got == want
        if not quiet:
            print(f"  {'✓' if ok else '✗'} 期望 {want} 实际 {got}  {src[:52]}")
        fails += 0 if ok else 1
    if not KNOWN_BORROW:
        if not quiet:
            print("  ✓ selftest KNOWN_BORROW 为空（本仓目前没有已判定的错借）")
    if not quiet:
        print(f"  selftest: {len(SELFTEST) - fails}/{len(SELFTEST)} 通过")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    hits, files = scan()
    if files == 0:
        print("扫描域为空 ⇒ 没有读数", file=sys.stderr)
        return 2
    unregistered = [h for h in hits if (h["a"], h["b"]) not in KNOWN_ALIAS and (h["a"], h["b"]) not in KNOWN_BORROW]
    borrows = [h for h in hits if (h["a"], h["b"]) in KNOWN_BORROW]
    if "--json" in argv:
        print(json.dumps({"files": files, "fallbacks": len(hits), "unregistered": unregistered,
                          "borrows": borrows}, ensure_ascii=False, indent=2))
        return 1 if (unregistered or borrows) else 0
    print(f"扫描 {files} 个源文件：跨 env 回退 {len(hits)} 处"
          f"（已登记 alias {len(hits) - len(unregistered) - len(borrows)}，未登记 {len(unregistered)}，borrow {len(borrows)}）")
    for h in unregistered[:12]:
        print(f"    ✗ {h['file']}:{h['line']}  {h['a']} → {h['b']}   {h['text']}")
    for h in borrows[:12]:
        print(f"    ✗（已判定错借）{h['file']}:{h['line']}  {h['a']} → {h['b']}", file=sys.stderr)
    if unregistered or borrows:
        print("  ⇒ 每个跨变量回退必须回答：这两个是**同一个概念**吗？"
              "是 ⇒ 登记进 KNOWN_ALIAS；不是 ⇒ 禁止（改成显式判空，别用 || 借）。", file=sys.stderr)
        return 1
    print("  ✓ 所有跨 env 回退都已登记为「同概念别名」")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
