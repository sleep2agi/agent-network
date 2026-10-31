#!/usr/bin/env python3
"""兼容字段 `license` 的**生产不可达护栏**。

2026-10-31 —— 起因（外部复核，原话）：
    「`sla_hours` 加生产不可达护栏：任何 `stats.summarize(..., sla_hours=...)` 都会红。」
    ⇒ 一个参数只要还能被生产代码传进来，那个旁路就一直在。

本仓的同类是 `/health` 的兼容字段 `license`：
    license: license?.type || "none"     ← 两种「没有」压成同一个字符串（语义不精确）
    判据请用 license_state（known / absent / unknown）
本仓当前**没有任何消费者**读 `.license` —— 这条护栏要保证它保持为零。

护栏口径：在 server/src / agent-node/src / agent-network/src（不含 *.test.ts）里，
除渲染点与赋值点之外，出现 `.license` 属性读取即红。

用法：python3 scripts/check-legacy-license-usage.py [--json]
退出码：0 = 没有旁路读取；1 = 有；2 = 拿不到读数（扫描域为空）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOTS = ["server/src", "agent-node/src", "agent-network/src"]
# 2026-10-31 —— 外部复核 (c)：「护栏不能弄红就等于没有」——每种绕过形状都要有 must-fire。
# 覆盖三种写法（第一版只有第一种，另外两种是真绕过）：
#   ① 点访问      body.license / body?.license
#   ② 下标访问    body["license"] / body['license']
#   ③ 解构        const { license } = body / { license, ...rest } = body
READ = re.compile(r"""
    \.license\b(?!_)
  | \[\s*["']license["']\s*\]
  | \{\s*license\s*[,}]
""", re.X)
ALLOW = {
    # 渲染点：把行渲染成兼容字符串（逐字保持旧行为，便于逐步下线）
    "server/src/license-state.ts": "legacyLicenseField 的渲染实现（兼容字段的唯一生产者）",
}
# 2026-10-31 —— 文件名级豁免太粗：`server/src/server.ts` 一旦整文件豁免，
# 在任何一行读 `.license` 做判断都不会红（witnessed 实测：注入旁路读取仍绿）。
# ⇒ 改成**行级**豁免：只放行赋值点那一行。
ALLOW_LINE = re.compile(r"^\s*license:\s*legacyLicenseField\(")


# 2026-10-31 —— **扫描域太窄 = 护栏只保护三分之一**（外部复核 (c) 的原话：
# 「三个调用点本来就在同一目录，但风险是真的，已扩域」）。
# 本仓实测：原来的三根 ROOTS 之外，`agent-network/bin/cli.ts` 有 **3 处**真在读 `.license`
#   （19283/19284/19513：CLI 把 /health 的 license 打出来）。
# ⇒ 域内（ROOTS）仍是「必须为零」；域外不是豁免，而是**白名单 + 理由**：
#   新增域外读取 ⇒ 红；白名单条目失效（文件没了 / 那行没了）⇒ 也红。
KNOWN_OUT_OF_DOMAIN = {
    ("agent-network/bin/cli.ts", "if (res && res.ok && res.license) {"):
        "CLI 只读展示：把 /health 的 license 打印给人看，不参与任何判定",
    ("agent-network/bin/cli.ts", "const lic = res.license;"):
        "同上（展示用变量）",
    ("agent-network/bin/cli.ts", 'if (health.license) info("License", health.license);'):
        "同上（info 一行）",
}


def _norm(text: str) -> str:
    return " ".join(text.split())


def tracked() -> list[Path]:
    """全仓 .ts（不含 *.test.ts）—— 域不再由三根目录决定，而由「域内/域外」分类决定。"""
    out = subprocess.run(["git", "ls-files", "*.ts"],
                         cwd=REPO, capture_output=True, text=True, timeout=60).stdout
    return [REPO / l for l in out.split("\n") if l.strip() and not l.endswith(".test.ts")]


def scan() -> tuple[list[dict], int]:
    hits, files = [], 0
    for p in tracked():
        if not p.exists():
            continue
        files += 1
        rel = str(p.relative_to(REPO))
        in_domain = any(rel.startswith(r + "/") for r in ROOTS)
        if in_domain and rel in ALLOW:
            continue
        for i, ln in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if ln.lstrip().startswith("//") or ln.lstrip().startswith("*"):
                continue
            if not READ.search(ln):
                continue
            if in_domain and ALLOW_LINE.search(ln):
                continue
            if not in_domain and (rel, _norm(ln.strip())) in KNOWN_OUT_OF_DOMAIN:
                continue
            hits.append({"file": rel, "line": i, "text": ln.strip()[:120], "in_domain": in_domain})
    return hits, files


def domain_health() -> list[str]:
    """域断言：域内三根必须各自还有源文件；域外白名单条目必须**仍然存在**。

    两条都是「域漂移」的抗体：
      · 某个 ROOT 被改名/删掉 ⇒ 域内变成 0 文件，扫描会静默变宽或变空
      · 白名单里那行被删了 ⇒ 白名单会静默变成「一张过去的照片」
    """
    problems: list[str] = []
    for root in ROOTS:
        n = sum(1 for p in tracked() if str(p.relative_to(REPO)).startswith(root + "/") and p.exists())
        if n == 0:
            problems.append(f"域内根 {root} 一个源文件都没有 ⇒ 域已漂移")
    for (rel, text), _why in KNOWN_OUT_OF_DOMAIN.items():
        p = REPO / rel
        if not p.exists():
            problems.append(f"域外白名单条目 {rel} 文件已不存在 ⇒ 白名单是过期照片")
            continue
        body = "\n".join(_norm(l) for l in p.read_text(encoding="utf-8", errors="replace").splitlines())
        if _norm(text) not in body:
            problems.append(f"域外白名单条目 {rel}: {text!r} 那行已不存在 ⇒ 白名单是过期照片")
    return problems


def selftest(quiet: bool = False) -> int:
    """一个必须命中的坏样本 + 一个必须放行的好样本。"""
    bad = 'const t = body.license ?? "none";'
    good = "const t = body.license_state;"
    cases = [
        (bad, True),
        (good, False),
        # 下标访问：第一版正则漏掉它（真绕过）
        ('const t = body["license"];', True),
        ("const t = body['license'] ?? 'none';", True),
        # 解构：同样绕过
        ("const { license } = body;", True),
        ("const { license, status } = body;", True),
        # 可选链（点访问的变体，必须同样命中）
        ("const t = body?.license;", True),
    ]
    _ = (bad, good)
    out = []
    for src, want in cases:
        got = bool(READ.search(src))
        if got != want:
            out.append(f"{src!r}: 期望 hit={want}，实际 {got}")
        elif not quiet:
            print(f"✓ selftest {'命中' if want else '不命中'}: {src}")
    if out:
        print("✗ 自检失败：", file=sys.stderr)
        for o in out:
            print(f"    · {o}", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {len(cases)} 例符合预期（3 种写法：点/下标/解构，各含正反例）")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        # shell 的 $? 只反映进程退出码；上面那次 witness 里 head 吞掉了它 ⇒ 这里显式返回。
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    drift = domain_health()
    if drift:
        print("✗ 扫描域漂移（先修域，再谈结论）：", file=sys.stderr)
        for d in drift:
            print(f"    · {d}", file=sys.stderr)
        return 1
    hits, files = scan()
    if files == 0:
        print("扫描域为空：一个源文件都没扫到 ⇒ 没有读数", file=sys.stderr)
        return 2
    if "--json" in sys.argv:
        print(json.dumps({"object": ROOTS, "files": files, "bypass_reads": hits,
                          "allow": ALLOW}, ensure_ascii=False, indent=2))
        return 1 if hits else 0
    in_d = [h for h in hits if h["in_domain"]]
    out_d = [h for h in hits if not h["in_domain"]]
    print(f"对象：{files} 个源文件（全仓 .ts，不含 *.test.ts）；读取 `.license` 的旁路点：{len(hits)}")
    print(f"  分域：域内（{'・'.join(ROOTS)}）{len(in_d)} 处 ｜ 域外 {len(out_d)} 处（白名单 {len(KNOWN_OUT_OF_DOMAIN)} 条）")
    if hits:
        print("✗ 有代码在读兼容字段 `license` —— 它区分不了「没有授权」与「没查到」：", file=sys.stderr)
        for h in hits[:20]:
            print(f"    · {h['file']}:{h['line']}  {h['text']}", file=sys.stderr)
        print("  ⇒ 判据请用 license_state（known / absent / unknown）；若确有渲染需求，登记进 ALLOW 并说明。",
              file=sys.stderr)
        return 1
    print("✓ 没有旁路读取：兼容字段只在渲染点与赋值点出现")
    sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
    from scope_block import print_scope  # noqa: E402
    print_scope(
        covers="全仓受版本管理的 .ts（不含 *.test.ts）里对兼容字段 `.license` 的点/下标/解构三种读取",
        does_not_cover="*.test.ts / 非 TS 文件 / 动态属性名（obj[k]）/ 跨仓消费者",
        threat_model="accident",
        reading_rule="域内 0 处只在同一次输出里打印了「域外白名单 3 条」时才有意义（域太窄的绿是假绿）",
        domain_count=files,
        domain_source="git ls-files *.ts（不含 *.test.ts）",
    )
    print("  check : 重跑本脚本；新增 `.license` 读取 ⇒ 红。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
