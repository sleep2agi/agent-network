#!/usr/bin/env python3
"""门：**「首次写」字段的写入必须是条件写**（`AND <col> IS NULL` 与 SET 同句）。

为什么不能靠测试：

    WHERE … IS NULL            ⇒ 只在未设时写 ⇒ 并发下也只有一个赢
    SELECT 然后 if 再 UPDATE    ⇒ 单线程下**同样绿**，并发下两个都写成功

所以「值有没有被保留」这条断言在单线程夹具里对两种写法都给绿——它测不到差别。
差别只在**语句本身**里能看见，因此这条判据必须落在文本上：`first_read_at`
出现在 SET 里时，同一条语句必须同时含 `AND first_read_at IS NULL`。

这是 `#3314` 复核里提出来的：那处（`node-request-retention.ts:102`）已经是条件写，
但当时只有一条注释在守它。注释不会红。

三态：
  exit 0 = 每个首写写入都是条件写
  exit 1 = 有非条件写（逐条打印 file:line + 语句片段）
  exit 2 = **一个写入都没找到** —— 「0 命中」不是「全对」：
           列名被改名 / 扫描器坏了 / 代码被搬走，都会让本门变得永远绿。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEARCH_ROOT = ROOT / "server" / "src"

# 列名 → 必须与本条 UPDATE 同句出现的谓词。
# 只登记**语义上确定是首写**的列；「看起来像时间戳」不是理由。
FIRST_WRITE_COLUMNS: dict[str, str] = {
    "first_read_at": "AND first_read_at IS NULL",
}

# 登记过的例外：文件 → 理由。空理由视为未登记。
# 测试夹具里的「时间拨回」（`SET first_read_at = first_read_at - ?`）是故意的，
# 但它必须被**写下来**，否则下一个人分不清「故意破条件」与「忘了条件」。
EXEMPT_FILES: dict[str, str] = {
    # 测试夹具把 first_read_at 往**前**拨，以跨越保留期、验证清理窗口。
    # 它是故意的非条件写（正是要覆盖「已经读过很久」这个状态），
    # 且它只会把时间改早，不会制造一个假的「首次读」。
    "server/src/node-request-retention.test.ts": "夹具把 first_read_at 前拨以跨越保留期（故意破条件写）",
}


def sql_statements(src: str) -> list[tuple[int, str]]:
    """抽出源码里的 SQL 字符串字面量（双引号与反引号），带起始行号。

    只抽字面量，不拼源码上下文：判据是「同一条语句里有没有那个条件」，
    而「同一条语句」的边界正是引号。
    """
    out: list[tuple[int, str]] = []
    for m in re.finditer(r'"(UPDATE\b[^"\\]*)"|`(UPDATE\b[^`]*)`', src, re.DOTALL):
        body = m.group(1) or m.group(2) or ""
        line = src.count("\n", 0, m.start()) + 1
        out.append((line, body))
    return out


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def sets_column(stmt: str, col: str) -> bool:
    """SET 子句里是否**赋值**这个列（不是 WHERE 里拿它做条件）。"""
    m = re.search(r"\bSET\b(.*?)\bWHERE\b", stmt, re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    set_clause = m.group(1)
    return re.search(rf"\b{re.escape(col)}\s*=", set_clause, re.IGNORECASE) is not None


def scan_file(path: Path, rel: str) -> tuple[list[str], int]:
    """返回 (问题清单, 命中数)。命中数用于区分「全对」与「一个都没扫到」。"""
    problems: list[str] = []
    hits = 0
    src = path.read_text()
    exempt = rel in EXEMPT_FILES
    for line, stmt in sql_statements(src):
        for col, predicate in FIRST_WRITE_COLUMNS.items():
            if not sets_column(stmt, col):
                continue
            hits += 1
            if norm(predicate).lower() in norm(stmt).lower():
                continue
            if exempt:
                if not EXEMPT_FILES[rel].strip():
                    problems.append(f"EXEMPT_WITHOUT_REASON: {rel} 登记了例外但理由是空的")
                continue
            snippet = norm(stmt)[:110]
            problems.append(
                f"UNCONDITIONAL: {rel}:{line} 写了 {col} 却没有「{predicate}」—— {snippet}"
            )
    return problems, hits


def run(target: Path, rel_root: Path) -> tuple[list[str], int]:
    problems: list[str] = []
    total = 0
    if target.is_file():
        files = [target]
    else:
        files = sorted(p for p in target.rglob("*.ts") if p.is_file())
    for path in files:
        rel = str(path.relative_to(rel_root)) if path.is_relative_to(rel_root) else str(path)
        if ".test." in path.name:
            # 测试夹具不是生产写入；但它们若也写这首写列，必须在 EXEMPT_FILES 里说一句。
            # 不静默跳过：跳过会掩盖「生产代码被搬进测试」这类事故。
            p, h = scan_file(path, rel)
            if h and not EXEMPT_FILES.get(rel, "").strip():
                problems.append(
                    f"TEST_WRITES_FIRST_WRITE_COLUMN: {rel} 在测试里写首写列（{h} 处）——"
                    f" 若是故意破条件，请把它登记到 EXEMPT_FILES 并写理由"
                )
            total += h
            continue
        p, h = scan_file(path, rel)
        problems += p
        total += h
    return problems, total


SELFTEST_CASES = [
    (
        "条件写 ⇒ 0 问题",
        'db.run("UPDATE t SET first_read_at = ?1 WHERE id = ?2 AND first_read_at IS NULL", [a, b]);',
        [],
    ),
    (
        "非条件写 ⇒ UNCONDITIONAL",
        'db.run("UPDATE t SET first_read_at = ?1 WHERE id = ?2", [a, b]);',
        ["UNCONDITIONAL"],
    ),
    (
        "两次写入只坏一条 ⇒ 只报那一条（不连坐）",
        'db.run("UPDATE t SET first_read_at = ?1 WHERE id = ?2 AND first_read_at IS NULL", [a, b]);\n'
        'db.run("UPDATE t SET status = ?1, first_read_at = ?2 WHERE id = ?3", [s, a, b]);',
        ["UNCONDITIONAL"],
    ),
    (
        "反引号多行 SQL 也要抓到",
        "db.run(`UPDATE t\n   SET first_read_at = ?1\n WHERE id = ?2`, [a, b]);",
        ["UNCONDITIONAL"],
    ),
    (
        "只在 WHERE 里用该列（不是赋值）⇒ 不算写入，不报",
        'db.run("UPDATE t SET status = ?1 WHERE id = ?2 AND first_read_at IS NULL", [s, b]);',
        [],
    ),
    (
        "根本没有写入 ⇒ 0 问题但命中 0（由 main 判 exit 2）",
        'console.log("no sql here");',
        [],
    ),
]


# 2026-11-01 —— **数量钉防删除，不防替换**：七个用例换成七个必定通过的，计数仍是 7。
# 所以再加一条**强度下界**：必须有几个用例的期望是「报错」，而不是「没问题」。
# 负例数为 0 时，整个自检只剩「合法输入不报错」，而那什么都证明不了。
NEGATIVE_EXPECTED = 3


def selftest() -> int:
    bad = 0
    negative = sum(1 for _, _, exp in SELFTEST_CASES if exp)
    if negative < NEGATIVE_EXPECTED:
        print(f"✗ 负例（期望报错的用例）只有 {negative} 个，应至少 {NEGATIVE_EXPECTED} 个")
        print("  ⇒ 数量没变但强度掉了：把负例换成「合法输入」也会让计数保持为 6/6")
        bad += 1
    for label, src, expect_prefixes in SELFTEST_CASES:
        tmp = Path("/tmp/first-write-selftest.ts")
        tmp.write_text(src)
        problems, _ = scan_file(tmp, "fixture.ts")
        got = [p.split(":")[0] for p in problems]
        ok = sorted(got) == sorted(expect_prefixes)
        print(f"{'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            bad += 1
            print(f"        got={got} want={expect_prefixes}")
    print(f"\nselftest: {len(SELFTEST_CASES) - bad}/{len(SELFTEST_CASES)}"
          f"（其中负例 {negative}/{NEGATIVE_EXPECTED}）")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--root", type=Path, default=SEARCH_ROOT, help="扫描根（默认 server/src）")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not args.root.exists():
        print(f"exit 2: 读不到扫描根 {args.root} —— 这不是「没有问题」")
        return 2

    problems, hits = run(args.root, args.root.parent.parent)
    if problems:
        for p in problems:
            print(p)
        print(f"\n{len(problems)} 处违反（窗口内命中 {hits} 处首写写入）")
        return 1
    if hits == 0:
        print("exit 2: **一个首写写入都没扫到** —— 列名改了 / 扫描器坏了 / 代码搬走了")
        print(f"  登记的列：{', '.join(sorted(FIRST_WRITE_COLUMNS))}；扫描根：{args.root}")
        print("  「0 命中」与「全部合规」在同一句话里同形，所以这里必须分开。")
        return 2
    print(f"ok: {hits} 处首写写入全部是条件写（{', '.join(sorted(FIRST_WRITE_COLUMNS))}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
