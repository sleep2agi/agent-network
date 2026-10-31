#!/usr/bin/env python3
"""测试清单棘轮：**允许新增，不允许消失**。

## 为什么是「集合」而不是「计数」

2026-10-31 我亲手证过反例：一次「两个锚点之间整段替换」把两条测试连同区间内容一起删掉，
同时新增了两条别的 ⇒ **测试总数 31 → 31，看起来没变**。

⇒ 计数相同 ≠ 覆盖相同。
⇒ 唯一通用的检测器是**名字集合的差集**：它同时也是「测试文件被整段替换」这个事故类的检测器。

## 判据

本脚本对比 `scripts/test-inventory-baseline.json`：
  · 基线里有、现在没有  ⇒ **红**（有人删了测试，或整段替换吃掉了它）
  · 现在有、基线里没有  ⇒ 绿，并打印「新增 N 条，请跑 --update 落基线」
  · 集合完全相同        ⇒ 绿

## 它自己的盲区（必须打印，否则「0 消失」会被读成「全覆盖」）

测试名如果不是**字符串字面量**（模板串、常量拼接、循环生成），本脚本抓不到。
所以每次运行都打印两行分母：
  literal = 能抓到的（进集合）
  dynamic = 抓不到的（只计数，不进集合）
⇒ 「消失 0 条」严格来说只覆盖 literal 那部分；dynamic 那部分没有棘轮。

🔴 2026-10-31 补两条（都是这个脚本原来的盲区）：

  ① **集合对重数失明**：把一条 test("foo") 复制粘贴成两条 ⇒ 集合不变 ⇒ 绿。
     而 runner 对同名测试的输出去重/覆盖 ⇒ 你看到 1 条结果，实际有 2 条。
     ⇒ 这比「31→31」更隐蔽：那个至少数字变了，这个连数字都不变。
     ⇒ 所以保留集合的同时**加一条唯一性断言**：`rel::name` 不许重复。
        （重名意味着**任何按名字的报告都无法归因到具体那一条**，本身就是缺陷。）

  ② **未保护桶必须自带上限**：dynamic 原来只是一个打印出来的数。
     ⇒ 有人新增 100 条 test(模板字符串名) ⇒ dynamic 86→186 ⇒ 报表照样绿。
     ⇒ 所以 dynamic 也进基线，断言 `dynamic <= baseline.dynamic`。
     ⇒ 注意：把既有 literal 改成 dynamic 这件事**已经会被抓**（那些名字会进
        `disappeared`），所以这里封的是另一个洞 —— **新增**未保护测试是静默的。

  判据：**集合回答「有没有」，多重集回答「有几条」；
        一个写着「不受保护」的桶，必须自带上限，否则棘轮保护的是标签，不是内容。**
   把它打印出来，是让读者知道这条棘轮**覆盖到哪里为止** —— 与 L0/L1 的「没有读数」同一条纪律。

用法：
  python3 scripts/check-test-inventory.py            # 对比基线
  python3 scripts/check-test-inventory.py --update   # 用当前集合覆盖基线
"""
import json
import re
import subprocess
import sys
from pathlib import Path

BASELINE = "scripts/test-inventory-baseline.json"
# test("...") / it("...") —— 只认双引号/单引号/反引号字面量开头，且不含 ${}
TEST_CALL = re.compile(r"^\s*(?:test|it)\s*\(\s*([\"'`])((?:(?!\1).)*)\1")
DESCRIBE_CALL = re.compile(r"^\s*describe\s*\(\s*([\"'`])((?:(?!\1).)*)\1")
ANY_TEST_CALL = re.compile(r"^\s*(?:test|it)\s*\(")


def unseen_by_git(repo: Path) -> list[str]:
    """**git 看不见**的测试文件：未跟踪且未被忽略的那些。

    2026-10-31 —— 外部复核那条「四类漂移源」在本门的对应物：
      `git ls-files` 只列 **tracked**；而开发者刚写的测试文件在 `git add` 之前
      既不在 tracked，也不在「有改动」里 ⇒ 本门会报「无新增」，而那个文件确实存在。
    ⇒ 这里把它列出来（**只报告，不判红**）：CI 跑的是提交后的状态，本地则要有人知道。

    刻意不做的事：不把 ignored 的文件算进来（`node_modules` 之类）——
    忽略清单是「明确允许不存在于仓库」的东西，把它们当测试文件是另一种误报。
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "-o", "--exclude-standard", "-z"],
            cwd=repo, check=True, capture_output=True,
        ).stdout.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return []
    hints = []
    for rel in out.split("\0"):
        if not rel or rel.startswith("node_modules/"):
            continue
        if rel.endswith((".test.ts", ".test.mts", ".test.js")):
            hints.append(rel)
    return sorted(hints)


def tracked_files(repo: Path) -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=repo, check=True, capture_output=True
    ).stdout.decode("utf-8", "replace")
    files = []
    for rel in out.split("\0"):
        if not rel or rel.startswith("node_modules/"):
            continue
        if not (rel.endswith(".test.ts") or rel.endswith(".test.mts") or rel.endswith(".test.js")):
            continue
        files.append(repo / rel)
    return sorted(files)


# 正则字面量只能在「期待一个表达式」的位置起始；这是一份保守的启发式集合。
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")


def _strip_code(raw_lines: list[str]) -> list[str]:
    # 2026-10-31 —— 栈式剥字符串（第七个状态：模板串里的 ${...} 是**代码**）。
    # 旧实现把整段模板当纯文本，插值里的 `/`（`>/dev/null`、`/^[a-z/-]+$/`）会被当成正则起点，
    # 于是后面一段被吞、深度失衡 ⇒ 文件被误判「不配平」并整体排除出棘轮域。
    text = "\n".join(raw_lines)
    out = []
    i, n = 0, len(text)
    state = "code"          # code | tmpl | bcomment | lcomment
    interp: list[int] = []  # 每层 ${...} 的花括号计数
    prev = ""               # 上一个「有意义的代码字符」或关键字
    word = ""
    while i < n:
        ch = text[i]
        nx = text[i + 1] if i + 1 < n else ""
        if state == "lcomment":
            if ch == "\n":
                state = "code"
                out.append(ch)
            else:
                out.append(" ")
            i += 1
            continue
        if state == "bcomment":
            if ch == "*" and nx == "/":
                state = "code"
                out.append("  ")
                i += 2
            else:
                out.append("\n" if ch == "\n" else " ")
                i += 1
            continue
        if state == "tmpl":
            if ch == "\\":
                out.append("  ")
                i += 2
                continue
            if ch == "`":
                state = "code"
                out.append(" ")
                prev = "`"
                i += 1
                continue
            if ch == "$" and nx == "{":
                state = "code"
                interp.append(0)
                out.append(" ")   # 进入插值：**不记** { ，退出时也不记 }（两边都不记才配平）
                prev = "{"
                i += 2
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        # ---- code ----
        if ch == "/" and nx == "*":
            state = "bcomment"; out.append("  "); i += 2; continue
        if ch == "/" and nx == "/":
            state = "lcomment"; out.append("  "); i += 2; continue
        if ch == "`":
            state = "tmpl"; out.append(" "); i += 1; continue
        if ch in "\"'":
            q = ch
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == q or text[j] == "\n":
                    break
                j += 1
            out.append(" " * (j - i + 1))
            i = j + 1
            prev = "s"
            continue
        if ch == "/" and (prev == "" or prev in REGEX_PREV or prev == "return"):
            # ⚠️ 字符类 [...] 里的 `/` 不结束正则：`/^[A-Za-z0-9_@%+=:,./-]+$/` 就是反例。
            j = i + 1
            in_class = False
            while j < n:
                c = text[j]
                if c == "\\":
                    j += 2
                    continue
                if c == "\n":
                    break
                if c == "[":
                    in_class = True
                elif c == "]":
                    in_class = False
                elif c == "/" and not in_class:
                    break
                j += 1
            # ⚠️ 这里**不要**再 `j += 1`：调用方统一用 `i = j + 1` 跳过结束符，
            #    两处都加就把紧跟的逗号一起吃掉 ⇒ 下一个 token 的 prev 变成 "/"，
            #    于是数组里下一行的正则字面量被判成除法（pad-display-sweep.test.ts:51 的成因）。
            out.append(" " * (j - i + 1))
            i = j + 1
            # 正则字面量是**操作数**：它后面出现的 `/` 只能是除号。
            # 原来这里写 prev = "/"，而 "/" 不在 REGEX_PREV 里，看似也对 ——
            # 但下一行以 `/` 开头时（数组里的正则字面量），前一个 token 是逗号之前那次赋值，
            # 于是整行被判成除法 ⇒ 该行之后的深度全错（pad-display-sweep.test.ts:51 就是这么来的）。
            prev = "id"
            continue
        if ch == "{":
            if interp:
                interp[-1] += 1
            out.append(ch)
            prev = "{"
            i += 1
            continue
        if ch == "}":
            if interp:
                if interp[-1] == 0:
                    interp.pop()
                    state = "tmpl"
                    out.append(" ")
                    prev = "}"
                    i += 1
                    continue
                interp[-1] -= 1
            out.append(ch)
            prev = "}"
            i += 1
            continue
        if ch.isalpha() or ch == "$" or ch == "_":
            word += ch
            out.append(ch)
            i += 1
            continue
        else:
            if word:
                prev = "return" if word == "return" else "id"
                word = ""
            if not ch.isspace():
                prev = ch
        out.append(ch)
        i += 1
    return "".join(out).split("\n")


def collect(repo: Path) -> tuple[dict[str, int], int, list[str]]:
    """返回 (名字 → 出现次数, dynamic 计数)。

    用**多重集**而不是集合：集合对重数失明，而「同名测试出现两次」是一次真实事故
    （runner 会去重/覆盖 ⇒ 报告里只剩 1 条，另一条静默不跑）。
    """
    names: dict[str, int] = {}
    dynamic = 0
    # 2026-10-31 —— 用深度推 describe 路径时，**一处括号错配会让该文件之后的所有路径整体错位**。
    # 原实现把深度钳到 ≥0：那正好吃掉了「错配」这个唯一的报警值，而输出仍然是一个漂亮的数。
    # ⇒ 不在中途钳位，而是在**文件结束时断言深度为 0**；不为 0 ⇒ 该文件整体不可信。
    # (相对路径, 说明)。说明里带行号时更有定位力 —— 「文件末不为 0」只告诉你文件级，
    # 而「负深度」能指到具体一行（状态机在哪一行判错）。
    unreliable: list[tuple[str, str]] = []
    # 2026-10-31 —— 元素身份必须包含「让它合法的那个维度」。
    # 只按 file::name 计次会把「同一文件、不同 describe 里的同名」和
    # 「同一 describe 里写了两遍」合成同一个计数 —— 前者合法，后者是缺陷。
    # ⇒ 键里必须带上 describe 路径。这里用一个轻量的花括号深度栈来重建它。
    depth = 0
    stack: list[str] = []
    for path in tracked_files(repo):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = path.relative_to(repo)
        # 每个文件重置一次：describe 嵌套是文件内的结构，
        # 跨文件累计的 depth 会让上一个文件的花括号把下一个文件的路径吃掉。
        depth = 0
        stack = []
        raw_lines = text.splitlines()
        code_lines = _strip_code(raw_lines)
        lineno = 0
        for line, stripped in zip(raw_lines, code_lines):
            lineno += 1
            delta = stripped.count("{") - stripped.count("}")
            d = DESCRIBE_CALL.match(line)
            if d:
                while stack and len(stack) > max(depth, 0):
                    stack.pop()
                stack.append(d.group(2))
            if not ANY_TEST_CALL.match(line):
                depth += delta
                if depth < 0:
                    unreliable.append((str(rel), f"line {lineno}: negative depth {depth}"))
                    break
                while stack and len(stack) > depth:
                    stack.pop()
                continue
            m = TEST_CALL.match(line)
            if not m:
                dynamic += 1
                depth += delta
                if depth < 0:
                    unreliable.append((str(rel), f"line {lineno}: negative depth {depth}"))
                    break
                continue
            name = m.group(2)
            if not name.strip() or "${" in name:
                dynamic += 1
                depth += delta
                if depth < 0:
                    unreliable.append((str(rel), f"line {lineno}: negative depth {depth}"))
                    break
                continue
            # 记录时用「进入这一行之前」的深度；记录完再算这一行自己的花括号，
            # 否则 test 体的 `{` 会把后面的路径整体推深一格。
            path = ">".join(stack[:depth]) if stack else ""
            key = f"{rel}::{path}::{name}" if path else f"{rel}::{name}"
            names[key] = names.get(key, 0) + 1
            depth += delta
            # 2026-10-31 —— 负深度是**状态机本身**的信号，比「文件末不为 0」更有定位力：
            #   它说明某一段被误判成代码/注释（多出一个右括号）⇒ 后面的深度全错。
            # 不钳位只是「不让它被吃掉」；这里再给它一个立刻可读的落点（文件 + 行号）。
            if depth < 0:
                unreliable.append((str(rel), f"line {lineno}: negative depth {depth}"))
                break
        if depth < 0:
            continue  # 已记进 unreliable（带行号），不重复报「末端不配平」
        if depth != 0:
            unreliable.append((str(rel), f"end depth {depth}"))
    return names, dynamic, unreliable


def rename_pairs(gone: list[str], new: list[str]) -> tuple[list[tuple[str, str]], list[str], list[str]]:
    import difflib as _dl
    by_file: dict[str, list[str]] = {}
    for n in new:
        by_file.setdefault(n.split("::")[0], []).append(n)
    pairs: list[tuple[str, str]] = []
    used: set[str] = set()
    rest_gone: list[str] = []
    for g in gone:
        f = g.split("::")[0]
        best, score = None, 0.0
        for cand in by_file.get(f, []):
            if cand in used:
                continue
            r = _dl.SequenceMatcher(None, g, cand).ratio()
            if r > score:
                best, score = cand, r
        if best and score >= 0.80:
            pairs.append((g, best))
            used.add(best)
        else:
            rest_gone.append(g)
    rest_new = [n for n in new if n not in used]
    return pairs, rest_gone, rest_new


# 2026-10-31 —— 剥字符串状态机的**自检**。
#
# 为什么需要：「所有文件都配平」是一个弱预言机 —— 状态机坏得很轻时，它仍然可能全平衡
# （今天两次实测：一次 522 个文件不配平，一次只差一个文件，而两次的代码都「看起来对」）。
# ⇒ 用手写用例把踩过的三类 bug 各钉一条，并留一条**必须红**的用例（真不配平的文件）——
#   否则一个「永远返回 0」的实现也能通过前五条。
LEXER_SELFTEST = [
    # (说明, 源码, 期望的文件末深度)
    ("模板串插值里是代码", "const a = `x${y}z`;", 0),
    ("正则字符类里的 / 不结束正则", "const r = /^[a-z/]+$/;", 0),
    # 第二行必须**含一个花括号**：否则「逗号被吃掉」这件事不会改变深度，
    # 于是这条用例对那个 bug 就没有判别力（我第一版就是这样，witnessed-red 当场为空）。
    ("数组里的正则字面量（off-by-one 现场）",
     "const pats = [\n  /\\$\\{alias\\.padEnd\\(/,\n  /if \\(x\\) \\{/,\n];\n", 0),
    ("字符串里的花括号不计数", 'const s = "}"; const o = "{{";', 0),
    ("行注释里的花括号不计数", "// { this is not code\nconst x = 1;", 0),
    ("块注释里的花括号不计数", "/* { } */\nconst x = 1;", 0),
    ("**必须红**：真不配平的文件", "if (x) {\n  y();\n", 1),
]


LEXER_SELFTEST_EXPECTED = 7


def lexer_selftest(quiet: bool = False) -> int:
    # 2026-10-31 —— **遍历 0 个用例同样会通过**。
    # 用例表被清空/被删掉几条时，循环一句不报，结果与「全过」同形。
    # ⇒ 数量本身要钉住（外部复核给的同款钉子，照抄）。
    if len(LEXER_SELFTEST) != LEXER_SELFTEST_EXPECTED:
        print(f"✗ selftest 用例数应为 {LEXER_SELFTEST_EXPECTED}，实际 {len(LEXER_SELFTEST)} —— 有人动过用例表",
              file=sys.stderr)
        return 1
    bad = []
    for why, src, want in LEXER_SELFTEST:
        got_lines = _strip_code(src.split("\n"))
        got = sum(l.count("{") - l.count("}") for l in got_lines)
        if got != want:
            bad.append(f"{why}: 期望深度 {want}，实际 {got}")
        elif not quiet:
            print(f"✓ selftest {why}: 深度 {got}")
    if bad:
        print("✗ 剥字符串自检失败：", file=sys.stderr)
        for b in bad:
            print(f"    · {b}", file=sys.stderr)
        print("  ⇒ 两种成因：① 状态机坏了（修代码）② 用例描述的语言形态已变（改用例）。", file=sys.stderr)
        print("     判据：若该用例的输入在真实代码里已不存在 ⇒ 是用例过期。", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {len(LEXER_SELFTEST)} 例全部符合预期（含 1 个必须红的负例）")
    return 0


def predicate_digest() -> str:
    """「什么算一条测试」这件事的**定义指纹**。

    2026-10-31 —— 外部复核 (e)：「`{predicate, command, count}` 仍不够：
    谓词是**代码**，改 haystack 会静默放宽 ⇒ 需要 `{definition_sha256, count}`。」

    本仓的基线存的是**名字多重集**（比计数强），但「名字怎么被抽出来」仍是代码：
    把 TEST_CALL 的正则放宽一点（比如允许 `t(` 前缀），基线里不会多一条，
    而抽取范围变宽了 —— 那正是「改谓词不改变读数」的最坏形态。

    所以指纹只覆盖**谓词本体**（三条正则 + 去注释 + 采集函数），
    不含 main()/报告格式 —— 否则改一句提示语也要重落基线，会训练人无脑 --update。
    """
    import hashlib as _h
    import re as _re
    src = Path(__file__).read_text(encoding="utf-8")
    lines = src.splitlines()
    preds = [m.group(0) for m in _re.finditer(
        r"^(TEST_CALL|DESCRIBE_CALL|ANY_TEST_CALL) = re\.compile\(.*\)$", src, _re.M)]

    def fn_block(name: str) -> str:
        i = next((k for k, l in enumerate(lines) if l.startswith(f"def {name}(")), None)
        if i is None:
            return ""
        j = i + 1
        while j < len(lines) and not lines[j].startswith("def "):
            j += 1
        return "\n".join(lines[i:j])

    body = "\n".join(preds) + "\n" + fn_block("_strip_code") + "\n" + fn_block("collect")
    return _h.sha256(body.encode("utf-8")).hexdigest()

def main() -> int:
    if "--selftest" in sys.argv:
        return lexer_selftest()
    repo = Path(__file__).resolve().parent.parent
    # 2026-10-31 —— 「先证仪器，再读世界」：状态机自检不过 ⇒ 本文的任何计数都不是读数。
    if lexer_selftest(quiet=True) != 0:
        print("✗ 剥字符串状态机自检未通过 ⇒ 本次的计数不是读数（退出码 2）", file=sys.stderr)
        return 2
    counts, dynamic, unreliable = collect(repo)
    # 2026-10-31 —— 「git 知道的东西」≠「文件系统知道的东西」。
    unseen = unseen_by_git(repo)
    if unseen:
        print(f"⚠ {len(unseen)} 个测试文件**还没进 git**（因此不在上面的清单里）：", file=sys.stderr)
        for rel in unseen[:10]:
            print(f"    · {rel}", file=sys.stderr)
        print("  ⇒ 这不是失败：CI 跑的是提交后的状态。但在本地，「无新增」不能当成「没写新测试」。", file=sys.stderr)
    current = set(counts)
    baseline_path = repo / BASELINE

    print("mutates_subject: none（只读比对；不写任何文件）") if "--update" not in sys.argv else None
    print(f"literal 测试名: {len(current)} 条（多重集，共 {sum(counts.values())} 次出现）")
    print(f"dynamic 测试名: {dynamic} 条（**抓不到，不受逐条棘轮保护，但有上限**）")
    if unreliable:
        print(f"⚠ {len(unreliable)} 个文件括号不配平 ⇒ describe 路径可能整体错位，重名检测在这些文件里不可信：",
              file=sys.stderr)
        for f, why in unreliable[:10]:
            print(f"    · {f} —— {why}", file=sys.stderr)
        print("  ⇒ 负深度（带行号）说明剥字符串状态机在那一行判错（正则/模板串/块注释）；"
              "末端不为 0 说明文件本身不配平。两者都让该文件的重名检测不可信。", file=sys.stderr)

    # 注意：`rel::name` 不含 describe 路径 ⇒ **同名但在不同 describe 里是合法的**，
    # 仓库里现在就有 6 个这种（已记进基线的计数里）。所以这里不做「绝对值唯一」断言，
    # 而是做**多重集棘轮**：任何 key 的出现次数**不许比基线多**。
    #   · 复制粘贴一条测试 ⇒ 计数 +1 ⇒ 红（这正是要抓的那个洞）
    #   · 在新 describe 里合法地起同一个名字 ⇒ 也会 +1 ⇒ 需要 --update 并说明
    #     （代价是一次显式动作；换来的是「静默多出一条」不再可能）
    if "--update" in sys.argv:
        # 2026-10-31 —— 外部复核 ③：「自动生成产物的 diff 必须包含『为什么变』，
        # 而不只是『变了多少』—— 只含增量的 diff 无法被评审，只能被接受。
        #   --update：diff 里只有数字变化 ⇒ 评审无法从 diff 判断「为什么变」
        #   CUTOFF_COMMIT：diff 里出现一个 sha，而那个 sha 里有没有债务，别人能独立算」
        # ⇒ 本基线写入时同时记 source 三元（与「棘轮存的是命令不是数」同构）：
        #   谓词 / 命令 / 生成时的 commit。改了基线，diff 里就有一个可独立复核的 sha。
        try:
            src_commit = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=str(Path(__file__).resolve().parents[1]), text=True).strip()
        except Exception:  # noqa: BLE001
            src_commit = ""
        baseline_path.write_text(
            json.dumps(
                {
                    "names": sorted(current),
                    "counts": counts,
                    "dynamic": dynamic,
                    "source": {
                        "commit": src_commit,
                        "definition_sha256": predicate_digest(),
                        "command": "python3 scripts/check-test-inventory.py --update",
                        "predicate": "server/**/*.test.ts 里 test/it 的字面量名字（多重集）+ describe 内 dynamic 上限",
                    },
                },
                ensure_ascii=False,
                indent=1,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"✓ 基线已更新：{BASELINE}（{len(current)} 条 / dynamic {dynamic}）")
        # 2026-10-31 —— 外部复核那条：把「能不能重跑」从「要思考」变成「查字段」。
        #   mutation: none | self | other（self 类只能用「声明窗口内的 Δ」）
        print("  mutates_subject: self（写基线 ⇒ 改变**下一次比较**的输入；"
              "上一次读数与这一次描述的不是同一个基线）")
        return 0

    if not baseline_path.exists():
        print(f"✗ 缺少基线 {BASELINE}；先跑 --update 生成", file=sys.stderr)
        return 1

    raw = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline = set(raw["names"])
    baseline_dynamic = raw.get("dynamic")
    baseline_counts = raw.get("counts")
    src = raw.get("source") or {}
    if not src:
        print("⚠ 基线里没有 source 三元（旧格式）⇒ 本次无法报「为什么变」；下次 --update 会写入", file=sys.stderr)
    else:
        c = str(src.get("commit") or "")
        ok_sha = len(c) == 40 and all(ch in "0123456789abcdef" for ch in c)
        print(f"  baseline_source_commit: {c[:12] if ok_sha else f'✗ 非法 sha {c!r}'}"
              f"（本基线由 `{src.get('command','?')}` 生成）")
        # 2026-10-31 —— 谓词指纹：抽取规则变了 ⇒ 基线要重落，否则「读数没变」可能只是「范围变了而值没变」
        want_def = src.get("definition_sha256")
        now_def = predicate_digest()
        if want_def and want_def != now_def:
            print(f"✗ 抽取谓词变了（基线 {str(want_def)[:12]} ≠ 现在 {now_def[:12]}）", file=sys.stderr)
            print("  ⇒ 谓词是代码：放宽规则不会让基线多一条，只会让读数悄悄变宽。", file=sys.stderr)
            print("  ⇒ 若确为有意改动，跑 --update 并在提交信息里说明放宽了什么。", file=sys.stderr)
            return 1
        print(f"  baseline_predicate_sha256: {str(want_def)[:12] if want_def else '（旧格式，缺）'}")
        if not ok_sha:
            print("✗ source.commit 不是 40 位 hex ⇒ 这份基线无法被独立复核", file=sys.stderr)
            return 1

    # ① 多重集棘轮：同名出现次数不许增加（集合对重数失明）
    if isinstance(baseline_counts, dict):
        # 括号不配平的文件，其 describe 路径不可信 ⇒ 它们的键**不参与**重名棘轮。
        # 这是「已知不可信的域」，而不是「没问题」——所以同时把域大小报出来。
        skip_prefixes = tuple(f + "::" for (f, _why) in unreliable)
        def _in_unreliable(k: str) -> bool:
            return k.startswith(skip_prefixes) if skip_prefixes else False
        checked = {k: c for k, c in counts.items() if not _in_unreliable(k)}
        excluded = len(counts) - len(checked)
        pct = (100.0 * excluded / len(counts)) if counts else 0.0
        # 2026-10-31 —— 文件数与键数**不成比例**：读者看到「19 个文件」会估计影响面很小，
        # 而真实的被排除条数可能是它的几十倍。⇒ 两个量都要报，且报比例
        #（外部复核：7771/8058 条参与 ⇒ 287 条被排除 = 3.6%）。
        # 2026-10-31 —— 「0%」与「未定义」的区别只有一个字符，而报表单元格会把它们拉平。
        #   0% ⇒ 有分母、分子为 0；未定义 ⇒ 没有分母。`-` 与 `N/A` 读起来都像「测了，是零」。
        if not counts:
            print("重名棘轮域：undefined: no denominator（一个测试名都没收集到 ⇒ 这不是 0%，是没量到）")
            print("  ⇒ 先查收集器：tracked_files 是否为空 / 文件是否都读失败。", file=sys.stderr)
            return 2
        print(f"重名棘轮域：{len(checked)}/{len(counts)} 条键"
              f"（{len(unreliable)} 个文件因括号不配平被排除 ⇒ 被排除 {excluded} 条键 = {pct:.1f}%；"
              f"那些键里的重名**未检查**，不等于没有）")
        # 2026-10-31 —— 排除必须**指名**，否则「被排除 1 个文件」谁也不知道该看哪里。
        # 负深度的落点是「文件 + 行号」：它说明剥字符串状态机在那一行判错了
        # （这正是「不钳位」换来的信号 —— 钳位会把它吃掉）。
        for f, why in unreliable[:10]:
            print(f"    · 排除 {f} —— {why}")
        if not unreliable:
            # 2026-10-31 —— 域完整时要说出来：
            # 一个「0 个文件被排除」与「没跑排除逻辑」在输出上都是没有那一行。
            print("    ⇒ 棘轮域**完整**：每个测试键都参与重名检测（0 个文件被排除）")
        grew = sorted((k, baseline_counts.get(k, 0), checked[k]) for k in checked if checked[k] > baseline_counts.get(k, 0))
        if grew:
            print(f"✗ 有 {len(grew)} 条测试的**出现次数增加**了（集合不变，但实际多出一条）：", file=sys.stderr)
            for k, before, after in grew[:20]:
                print(f"    × {k}  {before} → {after}", file=sys.stderr)
            print("  ⇒ runner 会对同名测试去重/覆盖 ⇒ 报告里只剩 1 条，另一条静默不跑。", file=sys.stderr)
            print("  ⇒ 若是新 describe 里合法重名，请 --update 并在提交信息里说明。", file=sys.stderr)
            return 1
    else:
        print("⚠ 基线里没有多重集计数（旧格式）⇒ 本次跳过次数检查；下次 --update 会写入", file=sys.stderr)
    disappeared = sorted(baseline - current)
    added = sorted(current - baseline)

    # 2026-10-31 —— 「消失 + 新增」只定位了位置，没定位**关系**：
    #   改名 ⇒ 一条消失 + 一条新增（处置：接受，落基线）
    #   真删 ⇒ 一条消失（处置：问为什么）
    #   两者在输出上同形（都是两条列表），而处置相反 ⇒ 会把人引向改错的那一份。
    # ⇒ 用「同一文件 + 名字相似」把它们配成**疑似改名**，剩下的才是真消失/真新增。
    rename_pairs_out, gone_only, new_only = rename_pairs(disappeared, added)
    if rename_pairs_out:
        # 名字里的摘要只能提示「变了」，说明「变的是什么」要两个值并排。
        print(f"· 疑似**改名** {len(rename_pairs_out)} 对（同一文件、名字相似度 ≥0.80）：", file=sys.stderr)
        for before, after in rename_pairs_out[:10]:
            print(f"    ↔ {before}", file=sys.stderr)
            print(f"      → {after}", file=sys.stderr)
        print("  ⇒ 改名的处置是「接受并落基线」；真删除的处置是「问为什么」。两者不同，别混着看。", file=sys.stderr)

    # ② 未保护桶的上限：新增 dynamic 测试原来是静默的
    if baseline_dynamic is None:
        print("⚠ 基线里没有 dynamic 上限（旧格式）⇒ 本次不检查；下次 --update 会写入", file=sys.stderr)
    elif dynamic > baseline_dynamic:
        print(f"✗ dynamic 测试从 {baseline_dynamic} 涨到 {dynamic}：", file=sys.stderr)
        print(f"  多出 {dynamic - baseline_dynamic} 条**抓不到名字、因此不受逐条棘轮保护**的测试。", file=sys.stderr)
        print("  ⇒ 要么把它们改成字面量名字（推荐），要么在同一次提交里 --update 并说明理由。", file=sys.stderr)
        print("  ⇒ 判据：一个写着「不受保护」的桶必须自带上限，否则它只是一个会吞东西的口袋。", file=sys.stderr)
        return 1

    if disappeared:
        print(f"✗ 有 {len(disappeared)} 条测试**消失**了（计数相同也可能发生）：", file=sys.stderr)
        for name in gone_only[:20]:
            print(f"    - {name}", file=sys.stderr)
        if len(gone_only) > 20:
            print(f"    …（共 {len(gone_only)} 条）", file=sys.stderr)
        print("  ⇒ 若确为有意删除，请在同一次提交里跑 --update 并说明原因。", file=sys.stderr)
        return 1

    if disappeared and not gone_only:
        # 全部配对成改名 ⇒ 这里不该判失败
        pass
    if new_only or gone_only:
        print(f"· 新增 {len(new_only)} 条（绿）。落基线：python3 scripts/check-test-inventory.py --update")
        for name in new_only[:10]:
            print(f"    + {name}")
        if len(new_only) > 10:
            print(f"    …（共 {len(new_only)} 条）")
    else:
        print("✓ 测试清单与基线一致：无消失、无新增、无重名")
    # 2026-10-31 —— **自产摆据必须自报身份**（外部复核 ①：
    # 「用被测对象的出口去生成它的入口输入，等于让它自己出题自己判卷；
    #   它会稳定地给自己满分，因为出题时它已经把自己答不出的题删掉了。」）。
    # 本仓的基线正是 `--update` 自己写的 ⇒ 它只能发现**变化**，不能发现**从一开始就漏掉的**。
    # 2026-10-31 —— 棘轮必须写清放弃什么（外部复核：「集合相等不漏增长，漏的是重数」）
    # 外部复核 ②：同上 —— 放弃声明里的基数不能手打，必须来自产出者（这里是基线 + 本次实测）
    print(f"  ratchet_gives_up: 放弃『dynamic 名字的逐条身份』（上限 {baseline_dynamic}（基线）／实测 {dynamic}）；放弃『测试是否真的执行』")
    # 2026-10-31 —— **防护强度是 Σcap，不是每桶占比**（外部复核：
    # 「A 桶 cap 10；新增 B 桶 cap 5 并从 A 迁走 5 条 ⇒ 每桶都合规，而可豁免总量 10 → 15，
    #   受保护面扩大 50%. 可观测的量是 Σcap，不是每桶占比。」
    # 本仓目前只有一个桶（dynamic），所以 Σcap 就是它；这里把它单独打出来 ——
    # 一旦将来有人加第二个桶，这行会立刻变成两数相加，而不是两个各自"合规"的占比。
    caps = {"dynamic": baseline_dynamic or 0}
    total_cap = sum(int(v) for v in caps.values())
    print(f"  exempt_caps: Σcap={total_cap}（桶：{'，'.join(f'{k}={v}' for k, v in caps.items())}）"
          f" ⇒ 防护强度看这个和，不看每桶占比")
    print("  baseline_source: 自产（`--update` 由本脚本写出）")
    print("                   ⇒ 它证明「没有变化」，不证明「没有长期遗漏」；")
    print("                     后者只能靠与另一来源对账（例如 `bun test --listTests` 或 CI 实跑条数）。")
    if baseline_dynamic is not None and dynamic < baseline_dynamic:
        print(f"· dynamic 从 {baseline_dynamic} 降到 {dynamic}（好事，落基线：--update）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
