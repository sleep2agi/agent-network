#!/usr/bin/env python3
"""同名契约文件在两处实现时，**容错方向**是否相反。

2026-10-31 —— 起因（外部复核，原话）：
    「同一个契约有两份实现、容错方向相反、两边测试都绿 ——
      服务端的宽松路径产出的形状正好是客户端 exact-keyset 必拒的形状。」

这类缺陷的特征是：两边都「对」，只是对的是不同的东西。
它不会红，因为每一边的测试都在测自己那一侧的行为。

本脚本只能查**可静态看见的那一半**：字面同名的文件里，宽松标记（`.catch(`、`.optional()`、
`??`、`||`）与严格标记（`.strict()`、`z.literal(`、`exact`）的**方向差**。

它不能查：语义上同名但文件不同名的实现、跨语言实现、运行期才合并的契约。
⇒ 所以它是读数，不是门：报「哪几对同名文件在容错方向上不一致」，
   判断哪一侧才是契约的那一侧，需要人（或一张卡）。

用法：python3 scripts/report-contract-pairs.py [--json]
退出码：0 总是（读数脚本）；2 = 扫描域为空（没有读数）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GROUPS = {
    "server": REPO / "server" / "src",
    "agent-node": REPO / "agent-node" / "src",
    "agent-network": REPO / "agent-network" / "src",
}
LENIENT = (
    (".catch(", re.compile(r"\.catch\(")),
    (".optional()", re.compile(r"\.optional\(\s*\)")),
    ("??(空值合并)", re.compile(r"\?\?")),
)
STRICT = (
    (".strict()", re.compile(r"\.strict\(\)")),
    ("z.literal(", re.compile(r"z\.literal\(")),
    ("exact 键集", re.compile(r"EXACT|exact_keyset|exactKeySet")),
)


COPIED_BASELINE: dict[str, str] = {
    'codex-auth-fingerprint.ts': '689285557bf1',
    'codex-home-enforce.ts': 'de5f3ba27b12',
    'codex-inventory.ts': '5d4e47348763',
    'codex-rollout-history-guard.ts': '5351fc8c3b8a',
    'external-schedule-contract.ts': 'a865578c968c',
    'host-telemetry.ts': '9399bdcb8557',
    'node-files.ts': '6b55dc786d9a',
    'node-name.ts': '628328e729b1',
    'node-skills.ts': '77bb3ba24abb',
    'opencode-borrowed-launch-health.ts': '3e5ec8c197a2',
    'opencode-owner-mode.ts': '7c932368bf73',
    'opencode-preset.ts': '0ed6eebf6964',
    'opencode-runtime-binding.ts': '8482ac779ff0',
    'opencode-v2-configured-model.ts': '1472e67655d3',
    'opencode-versions.ts': 'b9750b386cb9',
    'posix-modes.ts': '426bf7e653cc',
    'probe-host-allowlist.ts': '4632e1b3fdbb',
    'process-telemetry.ts': '1bea1eb433c4',
    'provider-application.ts': 'c13b8fafe2c6',
    'provider-collection.ts': '538452f7bf8f',
    'provider-initialization.ts': '7e858bb3f0fa',
    'reserved-env.ts': '23bae14e42ec',
    'rules-file.ts': '24c630ec32f9',
    'scoped-secret-contract.ts': 'c06f7e3fa57b',
    'scoped-secret-env.ts': '3d6e42b337db',
    'start-resource-gate.ts': 'fade10a367b3',
    'task-content-limit.ts': '7dfc4ad8210d',
    'task-trace.ts': 'dd0508dfcf54',
    'tmux-format.ts': '871dd1837b03',
    'tmux.ts': '0d48fbf91592',
    'windows-rename-retry.ts': '4a45f6c4f902',
}


def sha12(path: Path) -> str:
    import hashlib
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        return "????????????"


def copies(files: dict[str, dict[str, Path]]) -> list[dict]:
    """逐字符相同的副本组。

    2026-10-31 —— 外部复核那条：「同一条判据复制在两个仓，今天逐字符相同
    ⇒ 任何单侧改动都会静默重开，而改的那一侧不知道另一端」。

    比「消费者埋在别仓」更深一层：那次是消费者在别处，这次是**判据**在别处。
    ⇒ 这里只给出「副本几份、sha 多少」；是否允许分叉是人的决定（见 COPIED_BASELINE）。
    """
    out = []
    for name, side in files.items():
        if len(side) < 2:
            continue
        shas = {g: sha12(p) for g, p in side.items()}
        out.append({
            "file": name,
            "sides": sorted(shas),
            "sha": shas,
            # 2026-10-31 —— **红的时候要打印两侧的真实路径**（外部复核 ③：
            # 「能让失败的仪器自己报原因的场合，就不要用第二台仪器去反推」）。
            # 之前只打印组名与 sha，人还得自己去找是哪两个文件 ⇒ 那一步就是反推。
            # 相对路径仅在仓内成立；selftest 用临时目录时必须退化成绝对路径，
            # 否则「打印路径」这个改进会让 selftest 直接崩（第一版就是这样）。
            "paths": {g: (str(p.relative_to(REPO)) if str(p).startswith(str(REPO)) else str(p))
                      for g, p in side.items()},
            "identical": len(set(shas.values())) == 1,
        })
    return out


def scan(path: Path) -> dict[str, int]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    out: dict[str, int] = {}
    for name, rx in LENIENT:
        n = len(rx.findall(text))
        if n:
            out[f"lenient:{name}"] = n
    for name, rx in STRICT:
        n = len(rx.findall(text))
        if n:
            out[f"strict:{name}"] = n
    return out



# 2026-10-31 —— 外部复核 ②：「not-applicable 必须带『哪个前提没满足』。
#   不带前提的 n/a 会被人当成『再试一次』」。
# ⇒ 退出码 3 的每一处都必须同时输出一行 `premise=<id>`，且 id 必须取自下面的闭集。
#   散文继续留在 stderr（给人看），premise 是给消费者分支用的（机器契约）。
NOT_APPLICABLE_PREMISES = {
    "missing_scan_root",          # 扫描根不全 ⇒ 副本组会因缺侧被误判成「已分叉」
    "no_discriminating_groups",   # 当前代码里没有这类组 ⇒ 这条不变量无处可验
}


def emit_not_applicable(premise: str, why: str) -> int:
    if premise not in NOT_APPLICABLE_PREMISES:
        raise SystemExit(f"内部错误：未登记的前提 id {premise!r}")
    print("verdict=not-applicable")
    print(f"premise={premise}")
    if why:
        print(f"  ⇒ {why}", file=sys.stderr)
    return 3

SELFTEST_EXPECTED = 5


def selftest(quiet: bool = False) -> int:
    """副本检测的可失败用例：一个「永远返回相同」的实现过不了第二条。"""
    import tempfile
    bad = []
    ran = 0
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "a").mkdir(); (root / "b").mkdir()
        body = "export const X = 1;\n"
        (root / "a" / "dup.ts").write_text(body)
        (root / "b" / "dup.ts").write_text(body)
        files = {"dup.ts": {"a": root / "a" / "dup.ts", "b": root / "b" / "dup.ts"}}
        c1 = copies(files)[0]
        ran += 1
        if not c1["identical"]:
            bad.append("两份逐字符相同应判 identical=True")
        elif not quiet:
            print("✓ selftest 两份逐字符相同 ⇒ identical=True")
        # 2026-10-31 —— n/a 的契约：**必须同时给出 verdict 与 premise**（外部复核 ②：
        # 「不带前提的 n/a 会被人当成『再试一次』」）。
        import contextlib as _ctx, io as _io
        buf = _io.StringIO()
        with _ctx.redirect_stdout(buf):
            rc = emit_not_applicable("missing_scan_root", "")
        ran += 1
        emitted = buf.getvalue()
        if rc != 3 or "premise=missing_scan_root" not in emitted or "verdict=not-applicable" not in emitted:
            bad.append("n/a 必须输出 verdict=not-applicable 且带 premise=<id>，并返回 3")
        elif not quiet:
            print("✓ selftest n/a 输出 verdict + premise，退出码 3")
        ran += 1
        try:
            emit_not_applicable("not_registered", "")
            bad.append("未登记的前提 id 必须直接报错（否则 premise 会漂成自由文本）")
        except SystemExit:
            if not quiet:
                print("✓ selftest 未登记前提 id ⇒ 直接报错")
        (root / "b" / "dup.ts").write_text(body + "// one side edited\n")
        ran += 1
        c2 = copies(files)[0]
        if c2["identical"]:
            bad.append("单侧改一行后仍判 identical=True —— 这条门对分叉是瞎的")
        elif not quiet:
            print("✓ selftest 单侧改一行 ⇒ identical=False（必须红的那一格）")
        files1 = {"solo.ts": {"a": root / "a" / "dup.ts"}}
        ran += 1
        if copies(files1):
            bad.append("只有一侧的文件不该被当成副本")
        elif not quiet:
            print("✓ selftest 只有一侧 ⇒ 不算副本")
    if ran != SELFTEST_EXPECTED:
        # 遍历 0 个用例同样会通过 ⇒ 数量本身要钉
        print(f"✗ 自检用例数应为 {SELFTEST_EXPECTED}，实际 {ran}", file=sys.stderr)
        return 1
    if bad:
        print("✗ 副本检测自检失败：", file=sys.stderr)
        for b in bad:
            print(f"    · {b}", file=sys.stderr)
        return 1
    if not quiet:
        # 这句以前硬编码「3 例」，加了两条 n/a 用例后它会继续报 3 —— 数字必须来自 SELFTEST_EXPECTED
        print(f"✓ selftest {ran} 例全部符合预期（含 1 个必须红的分叉例、2 个 n/a 契约例）")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 本次没有读数（退出码 2）", file=sys.stderr)
        return 2
    files: dict[str, dict[str, Path]] = {}
    # 2026-10-31 —— **前置条件要显式化**（外部复核那条：fail-close 的门通常因为
    # 「在 pooler/socket 下恒红」而被运维改松）。
    # 本脚本的同款：某个包目录不存在（单包检出 / 部分克隆）时，原先只是 `continue`，
    # 于是副本组从 3 侧变成 2 侧 ⇒ 被判成「已分叉」⇒ 红。那会把「本部署不适用」错报成「坏了」。
    missing_groups: list[str] = []
    for group, root in GROUPS.items():
        if not root.is_dir():
            missing_groups.append(group)
            continue
        for p in root.rglob("*.ts"):
            if p.name.endswith(".test.ts"):
                continue
            files.setdefault(p.name, {})[group] = p

    if missing_groups:
        # `not-applicable` 与 `unknown` 必须分开：前者说「别修仪器，换判据」，后者说「去补一次取数」。
        print(f"not-applicable：缺少扫描根 {missing_groups} ⇒ 本判据在此部署上不适用（不是通过，也不是失败）",
              file=sys.stderr)
        print("  ⇒ 副本组会因缺侧而被误判成『已分叉』，所以这里**不作判定**。", file=sys.stderr)
        print("  ⇒ 完整判定请在包含全部三个目录的检出上重跑本脚本。", file=sys.stderr)
        return emit_not_applicable("missing_scan_root", "换检出（含全部三个目录）再跑，不要重试同一命令")

    total_ts = sum(len(side) for side in files.values())
    if total_ts == 0:
        # 阳性对照：三个包里必然有大量 .ts；为 0 ⇒ basename 扫描坏了
        print("✗ 阳性对照失败：三个包里一个 .ts 都没扫到 ⇒ 此时「0 组同名」不是结论", file=sys.stderr)
        return 2
    shared = {name: side for name, side in files.items() if len(side) >= 2}
    if not shared:
        print("扫描域为空：没有任何同名契约文件 ⇒ 没有读数（不是「一致」）", file=sys.stderr)
        return 2

    rows = []
    for name, side in sorted(shared.items()):
        marks = {group: scan(p) for group, p in side.items()}
        tot = {g: sum(v for k, v in m.items() if k.startswith("lenient:")) for g, m in marks.items()}
        st = {g: sum(v for k, v in m.items() if k.startswith("strict:")) for g, m in marks.items()}
        groups = sorted(marks)
        # 方向差：一侧宽松标记多、另一侧严格标记多
        opposite = any(
            (tot[a] > tot[b] and st[b] > st[a]) or (tot[b] > tot[a] and st[a] > st[b])
            for i, a in enumerate(groups) for b in groups[i + 1:]
        )
        rows.append({
            "file": name,
            "sides": groups,
            "lenient": tot,
            "strict": st,
            "opposite_direction": opposite,
            "detail": marks,
        })

    cp = copies(files)
    dup = [c for c in cp if c["identical"] and len(c["sides"]) >= 2]
    diverged = [c for c in cp if not c["identical"] and c["file"] in COPIED_BASELINE]
    missing = sorted(set(COPIED_BASELINE) - {c["file"] for c in dup})

    if "--json" in sys.argv:
        print(json.dumps({
            "pairs": rows,
            "copies": {"identical": [{"file": c["file"], "sides": c["sides"], "sha": list(c["sha"].values())[0]} for c in dup],
                       "diverged_from_baseline": [{"file": c["file"], "sha": c["sha"]} for c in diverged],
                       "missing": missing},
            "object": "basename-matched .ts（不含 *.test.ts）",
        }, ensure_ascii=False, indent=2))
        if "--assert" in sys.argv and (diverged or missing):
            return 1
        return 0

    print("同名契约文件（basename 相同、非测试）—— 只查**可静态看见的**容错方向")
    print(f"对象：server/src · agent-node/src · agent-network/src（不含 *.test.ts）⇒ 共 {len(rows)} 对/组"
          f"（阳性对照：扫到 {total_ts} 个 .ts 文件）")
    print()
    print("| 文件 | 侧 | 宽松标记 | 严格标记 | 方向相反 |")
    print("|---|---|---|---|---|")
    for r in rows:
        for g in r["sides"]:
            print(f"| {r['file']} | {g} | {r['lenient'][g]} | {r['strict'][g]} | "
                  f"{'⚠️ 是' if r['opposite_direction'] else '—'} |")
    opp = [r for r in rows if r["opposite_direction"]]
    print()
    print(f"⇒ 方向相反的共 {len(opp)} 组：{[r['file'] for r in opp] or '（无）'}")
    print("⚠️ 这不是判据：同名的两侧**不一定是同一个契约**（也可能是两个各自独立的模块同名）。")
    print("   已知假阳（2026-10-31 人工核过）：opencode-v2-catalog.ts")
    print("     server 侧 = zod 快照 schema（strict/literal）；agent-node 侧 = 读端点目录（JSON.parse + ?? 默认值）")
    print("     ⇒ 两个不同契约同名，不是「容错方向相反」的那一类。")
    print("   要判定「哪一侧是契约的那一侧」，必须再读一次调用方 —— 本脚本没有那个能力。")
    print()
    print(f"逐字符相同的**副本**：{len(dup)} 组（共 {len(cp)} 组同名文件）")
    print("  ⇒ 判据复制在 N 个包里：任何单侧改动都会让副本分叉，而改的那一侧不知道另一端。")
    for c in dup[:8]:
        print(f"    · {c['file']} × {len(c['sides'])}（{', '.join(c['sides'])}）sha={list(c['sha'].values())[0]}")
    if len(dup) > 8:
        print(f"    …（共 {len(dup)} 组）")
    if diverged:
        print(f"\n⚠ 相对基线**已分叉** {len(diverged)} 组：", file=sys.stderr)
        for c in diverged:
            print(f"    · {c['file']} sha={c['sha']}", file=sys.stderr)
            for g, rel in sorted(c.get("paths", {}).items()):
                print(f"        {g}: {rel}", file=sys.stderr)
            # 逐侧 sha：两侧不同 == 分叉点就在这两个文件之间，不需要再去找
            for g, h in sorted(c["sha"].items()):
                print(f"        {g} sha={h}", file=sys.stderr)
        print("  ⇒ 分叉不一定是错（可能是有意解耦），但必须是**显式决定**：", file=sys.stderr)
        print("     要么把两侧改回一致，要么从 COPIED_BASELINE 里删掉这一行并说明理由。", file=sys.stderr)
    if missing:
        print(f"\n· 基线条目已不成立 {len(missing)} 组（不再是逐字符相同）：{', '.join(missing[:5])}", file=sys.stderr)
    print("check  : 重跑本脚本；新增同名文件会出现在表里，方向差与副本分叉都要显式看一眼。")
    # 2026-10-31 —— SCOPE 五字段：让「31 组副本」这个数带着边界出门
    _lib = Path(__file__).resolve().parent / "lib"
    if _lib.is_dir():
        import sys as _sysx
        _sysx.path.insert(0, str(_lib))
        try:
            from scope_block import print_scope
            print_scope(
                covers="server/src ・ agent-node/src ・ agent-network/src 三个目录下、按 basename 同名的 .ts（不含 *.test.ts）",
                does_not_cover="其它包 / tests 与 docs / 非 .ts / 运行期生成的代码",
                threat_model="accident",
                reading_rule="「31 组逐字符相同」只在同一次输出里「49 组同名」被同时打印时才有意义（分母是 49 不是 31）",
                failure_mode="loud",
                failure_mode_how="--assert 下任一副本分叉即 exit 1；缺扫描根时 exit 3（不适用，不是通过）",domain_count=len(dup) + 0 if False else max(1, len(dup)),
                domain_source="三个目录下 basename 同名的 .ts 组数（分母=同名组，不是副本组）",
                verified_on="local",
            )
        except Exception:
            pass
    if "--assert" in sys.argv and (diverged or missing):
        # 分叉 = 判据副本不再逐字符相同 ⇒ 必须是一次显式决定（改回去 / 删基线行并说明）
        print(f"\n✗ 副本分叉或基线失效：diverged={len(diverged)} missing={len(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
