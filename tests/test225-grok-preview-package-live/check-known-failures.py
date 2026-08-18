#!/usr/bin/env python3
"""把 test225 的报告和已知失败基线对一遍。

为什么是棘轮不是「跑通/跑不通」：
test225 现在是红的（2 条，见 #1020 / #1021），但它长期不在 CI 里。
实测已证明它之前那个绿是**假绿** —— 旧夹具硬写 target="bun"，
恰好等于旧审计硬写的期望值，两个错误互相同意（三方单变量实验见 #861 评论）。
所以「等它修好再接进来」是错的顺序：正因为没人跑，才分不出真绿假绿。

判据：
  · 报告里出现基线之外的 FAIL   -> 退出 1（新伤）
  · 基线里某条不再出现          -> 不退 1，打印提示（修好是好事，不该被门拦）
  · PASS 条数低于地板           -> 退出 1（0-count：套件根本没跑到那些层）

最后一条是分母断言。没有它，一个「构建成功但立刻崩掉」的运行会产出
0 个 FAIL —— 而 0 个 FAIL 在只比 FAIL 的判据下是最漂亮的绿。
"""
import re
import sys
from pathlib import Path

# 地板取自实测：b732d5ef 与 78ed67c7 两次完整运行都是 8 个 PASS。
# 取 7 留一格，是为了让「某一层被合法地合并/改名」不至于立刻误报，
# 但仍然拦得住「只跑了 L0 就崩了」（那种情况 PASS 只有 2）。
PASS_FLOOR = 7

FAIL_RE = re.compile(r"^FAIL:\s*(.+?)\s*$", re.M)
PASS_RE = re.compile(r"^PASS:", re.M)


def load_baseline(path: Path) -> list[str]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-known-failures.py <report.txt> <known-failures.txt>", file=sys.stderr)
        return 2
    report_path, baseline_path = Path(sys.argv[1]), Path(sys.argv[2])
    if not report_path.is_file():
        print(f"FAIL: 报告不存在:{report_path} —— 套件没产出报告等同于没跑", file=sys.stderr)
        return 1

    report = report_path.read_text(encoding="utf-8")
    actual = [m.strip() for m in FAIL_RE.findall(report)]
    baseline = load_baseline(baseline_path)
    passes = len(PASS_RE.findall(report))

    print(f"  pass_lines={passes} (floor={PASS_FLOOR})")
    print(f"  fail_lines={len(actual)} baseline_entries={len(baseline)}")

    rc = 0

    if passes < PASS_FLOOR:
        print(f"FAIL: PASS 只有 {passes} 条,低于地板 {PASS_FLOOR} —— 套件没跑到该跑的层,"
              f"这时候 FAIL 少不代表好", file=sys.stderr)
        rc = 1

    # 比集合不比计数。三方实验里有一组 FAIL 个数同样是 2,内容却完全不同
    # ({auth evidence, attach socket} vs {auth evidence, Feishu});
    # 只比数量会得出「没差别」这个错误结论。
    new = [f for f in actual if f not in baseline]
    gone = [b for b in baseline if b not in actual]

    for f in new:
        print(f"FAIL: 基线之外的新失败:{f}", file=sys.stderr)
        rc = 1

    for g in gone:
        # 修好了。不红 —— 让门去拦一个改进,会让人倾向于不修。
        print(f"  NOTE: 基线里这条不再出现,可以从 known-failures.txt 删掉了:{g}")

    if rc == 0 and not new:
        print(f"  OK: FAIL 集合与基线一致({len(actual)} 条),没有新伤。")
        # 🔴 原来这里无条件打印「这不表示 test225 是绿的」。
        #    在**全部修好**那一刻,那句话就是假的 —— 而那恰恰是最该说清楚的一刻。
        #    一个在成功路径上说假话的提示,比没有提示更糟:它会让人以为还有欠账。
        if not actual and not baseline:
            print("  这次报告里 0 条 FAIL,基线也是空的 —— test225 现在是真绿的。")
            print("  这道门从此守的是「不许出现新的失败」。")
        else:
            print(f"  注意:这**不**表示 test225 是绿的。它现在有 {len(baseline)} 条已知失败,")
            print(f"        每条都挂着 issue。这道门守的是「不要再多」,不是「已经没有」。")
    return rc


if __name__ == "__main__":
    sys.exit(main())
