#!/usr/bin/env python3
"""禁止把「键集」拼成字符串再比较 —— 这个形状会**静默通过**不该通过的形状。

## 为什么（2026-10-31 更新：碰撞已可构造，不再只是理论风险）

两行就能演示（用仓库里真实的 `exact()` 语义）：

    JSON.parse('{"code\\u0000tenantKey":"x","userOpenId":"y"}')
    Object.keys(b).sort().join("\0")  ===  ["code","tenantKey","userOpenId"].sort().join("\0")
    ⇒ exact() 返回 true，而 b.code / b.tenantKey 都是 undefined

    JSON.parse('{"":1}')  ⇒ Object.keys = [""]  ⇒ join("\0") = ""  ⇒ 与「无键」同值

🔴 所以 `"\0"` 不是「实践中不易撞」。根因也不是「这个字符不常见」，而是：
   **任何「用字符串拼接比较集合」的方案，都要求元素里不含分隔符，
     而 JSON 不提供这个保证（`"\u0000"` 是合法键名）。**

⇒ 结论：安全性不来自「选了一个不常见的分隔符」，来自**根本没有分隔符**。
⇒ 构造上安全的只有 `JSON.stringify(sorted)` 与逐元素比较（长度 + 每个下标）。

## 🔴 本门必须是**跨行**的（2026-10-31 修正）

早先这版是按行扫的。而实测：命中它的那几行长度是 350 / 315 / 305 / 279 / 260 字符，
全部远超 prettier 的 80/100/120 阈值 —— **一次格式化就会把它们断成多行**，
单行 grep 立刻漏掉；而最长的恰恰是键最多的、也最容易撞的那几个。
⇒ **盲区和风险落在同一个集合上。** 所以这里改用整段文本匹配，行号由偏移反算。

## 两类，一堵一报

· 阻塞：无参 `join()`（分隔符默认 `,`，调用点看不见）+ 键集 `join(<sep>)`
· 报告：数组 `join`（碰撞后果是去重口径，不是契约绕过）—— **打印但不阻塞**，
  因为「不阻塞」与「不存在」在沉默里长得一样。

而 `.test.ts` 里的 `Object.keys(x).sort().join()` 是**第三类**：
它把分隔符抄进期望值，测的是实现而不是契约。这一格**不能用 grep 判定**
（测试自己拼期望值是合法的），所以本门只**列出**它们，交给 review。
—— 生产侧有自动门、测试侧只有默认值，这个不对称必须显式打出来，
否则它会被读成「测试侧也已经收敛过了」。

## 判据

输出为空 + 退出码 0。不设基线、不设阈值：该形状没有任何合法用途。
"""
import re
import subprocess
import sys
from pathlib import Path

SRC = (".ts", ".mts", ".tsx", ".js", ".mjs", ".cjs")

# 整段匹配：`\s*` 自然跨行 ⇒ 覆盖 `x.sort()\n  .join(",")` 这种格式化后的形状。
SET_JOIN = re.compile(r"\.sort\s*\(\s*\)\s*\.join\s*\(\s*([^)]*?)\s*\)")
KEYSET = re.compile(r"Object\.(?:keys|getOwnPropertyNames)\s*\(")
# 键集判据的「向前看」窗口：exact 型判断里 Object.keys 通常在同一侧表达式上，
# 而格式化之后它可能在几十个字符之前。200 是实测能覆盖到的上界（最长行 350 字符）。
LOOKBEHIND = 200


def collect(repo: Path) -> list[Path]:
    """取集: git 跟踪的全部源文件（含测试文件 —— 测试侧要报，不要堵）。"""
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"], cwd=repo, check=True, capture_output=True,
        ).stdout.decode("utf-8", "replace")
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:  # pragma: no cover
        print(f"✗ 无法枚举文件（git ls-files 失败）: {exc}", file=sys.stderr)
        return []
    files = []
    for rel in out.split("\0"):
        if not rel or not rel.endswith(SRC) or rel.startswith("node_modules/"):
            continue
        files.append(repo / rel)
    return sorted(files)


def is_test_path(rel: str) -> bool:
    return ".test." in rel or ".spec." in rel or rel.startswith("tests/")


def scan(repo: Path):
    blocking: list[str] = []
    advisory: list[str] = []
    review: list[str] = []
    scanned = 0
    for path in collect(repo):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = str(path.relative_to(repo))
        scanned += 1
        test_file = is_test_path(rel)
        lines = text.splitlines()
        for m in SET_JOIN.finditer(text):
            lineno = text.count("\n", 0, m.start()) + 1
            arg = m.group(1)
            line = lines[lineno - 1].strip()[:110]
            # 注释里的示例不算代码。只按行首粗筛（宁可漏报注释，也不误堵代码）。
            if line.startswith("//") or line.startswith("*") or line.startswith("/*"):
                continue
            if not arg:
                # 无参：分隔符默认 ','，调用点看不见。
                (blocking if not test_file else review).append(
                    f"{rel}:{lineno}: 无参 join（分隔符默认 ','，调用点看不见）  {line}"
                )
                continue
            window = text[max(0, m.start() - LOOKBEHIND): m.start()]
            # 🔴 `Object.keys(` 必须和这次 join 在**同一条语句**里。
            #    只看「前面 200 字符里出现过」会误判：上一条语句里的 Object.keys
            #    会让下一条语句的数组 join 被算成键集判断（实测踩过）。
            #    语句边界用 `;` 近似（本项目不带分号的行极少，宁可漏报）。
            cut = window.rfind("Object.keys(")
            if cut < 0:
                cut = window.rfind("Object.getOwnPropertyNames(")
            tail = window[cut:] if cut >= 0 else ""
            if tail and ";" not in tail:
                (blocking if not test_file else review).append(
                    f"{rel}:{lineno}: 键集拼字符串（分隔符 {arg} 可碰撞 ⇒ 多一个键会被读成通过）  {line}"
                )
            else:
                advisory.append(f"{rel}:{lineno}: 数组 join（同类不同罪，本门不阻塞）  {line}")
    return blocking, advisory, review, scanned


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    blocking, advisory, review, scanned = scan(repo)

    if blocking:
        print(f"✗ 键集拼接 {len(blocking)} 处（应改为 JSON.stringify(sorted) 或逐元素比较）:", file=sys.stderr)
        for item in blocking:
            print(f"    {item}", file=sys.stderr)
    else:
        print(f"✓ 无参 join / 键集拼接: 0 处（跨行匹配，扫描 {scanned} 个源文件）")

    if advisory:
        print(f"· 数组 join（不阻塞，{len(advisory)} 处，后果是去重口径而非契约绕过）:")
        for item in advisory:
            print(f"    {item}")
    else:
        print("· 数组 join（不阻塞）: 0 处")

    # 🔴 这一块的意义是**把「默认值」变成「一行输出」**：
    #    测试里出现 join 时，合法与非法从语法上分不出（测试可以自己拼期望值），
    #    所以这里不判，只列。但「列出来」与「没人提过」是两件事。
    if review:
        print(f"⚠ 测试文件里出现键集拼接 {len(review)} 处（不阻塞，需 review 判断是测契约还是测实现）:")
        for item in review:
            print(f"    {item}")
    else:
        print("⚠ 测试文件里出现键集拼接: 0 处")

    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
