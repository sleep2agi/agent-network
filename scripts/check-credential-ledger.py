#!/usr/bin/env python3
"""凭据台账的**结构门** —— 让那张表自己会腐朽，而不是靠人记得回头看。

#2719 / #3306。台账的价值全在「出事那一刻能查到换掉要动什么」，而它最常见的坏法有三种：

  ① 多一列少一列 ⇒ 表格看起来还在，但某一行少的那一列**恰好**是撤销改点
  ② 有人顺手把密钥内容贴进来 ⇒ 台账本身成了新的泄漏面
  ③ 「已填 / 待填」计数停在过去某一天 ⇒ 读数变成叙述

三种都**不会让任何东西报错**，所以它们必须各有一条断言。

用法：
    python3 scripts/check-credential-ledger.py            # 检查
    python3 scripts/check-credential-ledger.py --selftest  # 判据自检（含必须红的负例）
    python3 scripts/check-credential-ledger.py --file X    # 指定文件（自检用）

退出码：0 = 全部成立；1 = 有违规；2 = 没有读数（文件不存在 / 表头认不出）
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / "docs" / "ops" / "credential-ledger.md"

# 6 列：资产 / 指纹 / 持有人 / 用途 / 最近使用 / 撤销后要改哪些地方
COLUMNS = 6
REVOCATION_COL = 5          # 0-based：最后一列
PLACEHOLDER = "（待填）"

# 疑似密钥内容。**故意只认高置信形态**：宁可漏一个怪格式，也不要天天误报把门关掉。
SECRET_PATTERNS = [
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"), "OpenAI 风格 sk- token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "PEM 私钥块"),
    (re.compile(r"\b[A-Fa-f0-9]{40,}\b"), "40+ 位十六进制（私钥/令牌常见形态）"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "GitHub token"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{20,}\b"), "npm token"),
]

COUNT_LINE = re.compile(r"已填\s*(\d+)\s*行\s*/\s*待填\s*(\d+)\s*行")


def data_rows(text: str) -> list[list[str]]:
    """提取台账正文的数据行（跳过表头与分隔行）。认不出表头 ⇒ 返回空（调用方判 2）。"""
    rows: list[list[str]] = []
    in_table = False
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            if in_table and rows:
                break            # 表格结束
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if not in_table:
            header = " ".join(cells)
            if "资产名" in header and "撤销" in header:
                in_table = True
            continue
        if set("".join(cells)) <= set("-: "):
            continue             # 分隔行
        rows.append(cells)
    return rows


def problems(text: str) -> tuple[int, list[str]]:
    """→ (数据行数, 违规清单)。行数 0 表示「没有读数」，由调用方转成退出码 2。"""
    rows = data_rows(text)
    out: list[str] = []
    if not rows:
        return 0, out

    for i, cells in enumerate(rows, start=1):
        if len(cells) != COLUMNS:
            out.append(f"第 {i} 行有 {len(cells)} 列，应为 {COLUMNS}：{' | '.join(cells)[:80]}")
            continue
        if not cells[REVOCATION_COL] or cells[REVOCATION_COL] in ("-", "—"):
            out.append(f"第 {i} 行的「撤销后要改哪些地方」为空 —— 没有它，台账只回答「谁持有」")

    # 密钥内容：**整段的**，不只是单元格（贴进正文也算）
    for pat, why in SECRET_PATTERNS:
        for m in pat.finditer(text):
            snippet = m.group(0)[:12]
            out.append(f"疑似密钥内容（{why}）：{snippet}… —— 台账只记元数据")

    # 计数一致性：文件自己声明「已填 X / 待填 Y」，这两数必须与实际行数对得上
    m = COUNT_LINE.search(text)
    if not m:
        out.append("找不到「已填 X 行 / 待填 Y 行」读数 —— 空表与填好的表在报告上同形，这个数必须写")
    else:
        filled, pending = int(m.group(1)), int(m.group(2))
        actual_filled = sum(1 for c in rows if len(c) == COLUMNS and c[2] and c[2] != PLACEHOLDER)
        actual_pending = len(rows) - actual_filled
        if (filled, pending) != (actual_filled, actual_pending):
            out.append(
                f"计数与实际不符：文件写 已填 {filled}/待填 {pending}，实际 已填 {actual_filled}/待填 {actual_pending}"
                " —— 计数不是装饰，它是这张表唯一能证明「有人维护过」的读数"
            )
    return len(rows), out


SELFTEST_EXPECTED = 6


def selftest() -> int:
    """六例：好表 / 少一列 / 撤销列为空 / 贴了密钥 / 计数不符 / 没有表。"""
    good = """| 资产名 | 指纹 | 持有人 | 用途 | 最近一次使用 | 撤销后要改哪些地方 |
|---|---|---|---|---|---|
| A | abc | 甲 | 签名 | 2026-11-01 | release.yml 的 SECRET_A |
| B | （待填） | （待填） | 公证 | （待填） | （待填） |
已填 1 行 / 待填 1 行
"""
    cases = [
        ("好表", good, 0),
        ("少一列", good.replace("| A | abc | 甲 | 签名 | 2026-11-01 | release.yml 的 SECRET_A |", "| A | abc | 甲 | 签名 | 2026-11-01 |"), 1),
        ("撤销列为空", good.replace("release.yml 的 SECRET_A", " "), 1),
        ("贴了密钥", good.replace("abc |", "sk-abcdefghijklmnopqrstuvwx |", 1), 1),
        ("计数不符", good.replace("已填 1 行 / 待填 1 行", "已填 2 行 / 待填 0 行"), 1),
        ("没有表", "just prose\n", 2),
    ]
    fails = 0
    for label, text, want in cases:
        n, probs = problems(text)
        got = 2 if n == 0 else (1 if probs else 0)
        if got != want:
            fails += 1
            print(f"  ✗ {label}: 期望 {want} 实际 {got}（{probs[:1]}）")
        else:
            print(f"  ✓ {label} ⇒ {got}")
    if len(cases) != SELFTEST_EXPECTED:
        print(f"✗ 用例数应为 {SELFTEST_EXPECTED}，实际 {len(cases)}", file=sys.stderr)
        return 1
    if fails:
        print(f"✗ 自检失败 {fails} 例", file=sys.stderr)
        return 1
    print(f"✓ selftest {SELFTEST_EXPECTED}/{SELFTEST_EXPECTED} 通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest() != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2

    path = DEFAULT_FILE
    if "--file" in sys.argv:
        path = Path(sys.argv[sys.argv.index("--file") + 1])
    if not path.exists():
        print(f"✗ {path} 不存在 —— 没有台账就没有读数（不等于「没有凭据」）", file=sys.stderr)
        return 2

    text = path.read_text(encoding="utf-8")
    n, probs = problems(text)
    if n == 0:
        print(f"✗ {path} 里认不出台账表 —— 没有读数", file=sys.stderr)
        return 2
    if probs:
        print(f"✗ {path}: {len(probs)} 处违规", file=sys.stderr)
        for p in probs:
            print(f"  · {p}", file=sys.stderr)
        return 1
    print(f"✓ {path.name}: {n} 行台账，6 列齐全，撤销改点非空，无疑似密钥内容，计数自洽")
    return 0


if __name__ == "__main__":
    sys.exit(main())
