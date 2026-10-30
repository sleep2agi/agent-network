#!/usr/bin/env python3
"""禁止把「键集」拼成字符串再比较 —— 这个形状会**静默通过**不该通过的形状。

## 为什么

判断「一个对象只有这几个键」最省事的写法是:

    if (Object.keys(body).sort().join(",") !== "a,b") reject()

它在**每一种分隔符**下都可碰撞:

    ["a,b", "c"].join(",")   =  a,b,c
    ["a", "b,c"].join(",")   =  a,b,c          ← 两个不同键集，同一个字符串
    ["a b", "c"].join(" ")   =  a b c
    ["a", "b c"].join(" ")   =  a b c
    ["a\\0b", "c"].join("\\0") =  a\\0b\\0c
    ["a", "b\\0c"].join("\\0") =  a\\0b\\0c     ← JSON 允许 "\\u0000" 做键名

🔴 关键在于**方向**: 碰撞让「多一个键」的请求被读成「正好这几个键」，于是**通过**。
   所以它不是「偶尔红」，是**在恰好的输入上静默绿** —— 比红更坏。

构造上安全的只有两种: `JSON.stringify(sorted)` 与逐元素比较(长度 + 每个下标)。
`"\\0"` 只是「实践中不易撞」，它依赖「键里不含 NUL」这个**约定**；约定可以被打破，
构造不能。所以本门把 `"\\0"` 也算违规。

## 两个形态，一个阻塞

形态 A —— **无参** `sort().join()`: 分隔符默认是 `,`，而**调用点看不见**它。
         无论接收者是键集还是数组，这条都禁（看不见的分隔符无法被审阅）。

形态 B —— 带参 `sort().join(<sep>)`，且同一条表达式链上出现
         `Object.keys(` / `Object.getOwnPropertyNames(`: 这就是在比键集。

## 🔴 为什么数组 join 不阻塞

本仓实测有 4 处 `.slice().sort().join(",")` —— 它们是**数组去重 key**，不是契约判断。
碰撞后果不同:

    键集碰撞   ⇒ 绕过契约检查（**静默放行不该放行的形状**）
    数组去重碰撞 ⇒ 两个不同集合被当成同一个 key（合并/去重口径错误）

同类不同罪。本门**不阻塞**它们，但**必须把它们打印出来** —— 因为「不阻塞」和
「不存在」在沉默里长得一样，而沉默会被读成后者。这是本仓 scripts/qa.sh 与
preflight-local.sh 共同的立门原则: 对没跑/没管的部分明确输出，而不是留白。

## 判据

输出为空 + 退出码 0。不设基线、不设阈值 —— 这个形状没有任何合法用途，
所以「零」可以从第一天就是绿的，不需要存量豁免。
"""
import re
import subprocess
import sys
from pathlib import Path

SRC = (".ts", ".mts", ".tsx", ".js", ".mjs", ".cjs")

# 形态 A: sort().join() —— 无参。`slice().sort().join()` / `keys.sort().join()` 都命中。
NOARG = re.compile(r"\.sort\(\)\s*\.join\(\s*\)")

# 形态 B: sort().join(带参)。是否键集由同一行是否出现 KEYSET 决定。
WITHARG = re.compile(r"\.sort\(\)\s*\.join\(\s*(['\"][^'\"]*['\"]|`[^`]*`)\s*\)")
KEYSET = re.compile(r"Object\.(?:keys|getOwnPropertyNames)\s*\(")

# 「它其实是安全写法」的白名单形状: 拼完立刻 JSON.stringify 不算（这里反过来，
# 是 `join` 出现在字符串字面量或注释里）。只按行首 `//` / `*` 粗筛，宁可多报。
COMMENT = re.compile(r"^\s*(//|\*|/\*)")


def collect(repo: Path) -> list[Path]:
    """取集: git 跟踪的源文件。

    用 `git ls-files` 而不是 rglob —— 后者会扫进 node_modules / dist，
    分母虚高几万，而且把第三方代码算成违规。
    代价: 看不见**未跟踪的新文件**，本地跑之前要先 `git add`。
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=repo,
            check=True,
            capture_output=True,
        ).stdout.decode("utf-8", "replace")
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:  # pragma: no cover
        print(f"✗ 无法枚举文件（git ls-files 失败）: {exc}", file=sys.stderr)
        return []
    files = []
    for rel in out.split("\0"):
        if not rel or not rel.endswith(SRC):
            continue
        # 测试文件不在此门管辖: 测试里出现 join( 时它测的是实现，不是契约。
        # 那件事的处置是「不要那样写断言」，不是「不许跑」。
        if ".test." in rel or rel.startswith("node_modules/"):
            continue
        files.append(repo / rel)
    return sorted(files)


def scan(repo: Path) -> tuple[list[str], list[str], int]:
    blocking: list[str] = []
    advisory: list[str] = []
    scanned = 0
    for path in collect(repo):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        scanned += 1
        for lineno, line in enumerate(text.splitlines(), 1):
            if COMMENT.match(line):
                continue
            rel = path.relative_to(repo)
            if NOARG.search(line):
                # 形态 A 一律阻塞: 分隔符在调用点不可见。
                blocking.append(f"{rel}:{lineno}: 无参 join（分隔符默认 ','，调用点看不见）  {line.strip()[:110]}")
                continue
            if WITHARG.search(line):
                if KEYSET.search(line):
                    sep = WITHARG.search(line).group(1)
                    blocking.append(
                        f"{rel}:{lineno}: 键集拼字符串（分隔符 {sep} 可碰撞 ⇒ 多一个键会被读成通过）  {line.strip()[:110]}"
                    )
                else:
                    advisory.append(f"{rel}:{lineno}: 数组 join（同类不同罪，本门不阻塞）  {line.strip()[:110]}")
    return blocking, advisory, scanned


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    blocking, advisory, scanned = scan(repo)

    if blocking:
        print(f"✗ 键集拼接 {len(blocking)} 处（应改为 JSON.stringify(sorted) 或逐元素比较）:", file=sys.stderr)
        for item in blocking:
            print(f"    {item}", file=sys.stderr)
    else:
        print(f"✓ 无参 join / 键集拼接: 0 处（扫描 {scanned} 个非测试源文件）")

    # 🔴 这一块必须打印，即使为 0。它的用途不是拦截，是让「被排除在门外的
    #    同类形状」有一个可见的读数 —— 否则下一个人会以为全仓只有阻塞那几种。
    if advisory:
        print(f"· 数组 join（不阻塞，{len(advisory)} 处，后果是去重口径而非契约绕过）:")
        for item in advisory:
            print(f"    {item}")
    else:
        print("· 数组 join（不阻塞）: 0 处")

    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
