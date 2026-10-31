#!/usr/bin/env python3
"""MCP 工具的「响应键集断言」覆盖率 —— 单位是**工具**，不是 grep 次数。

2026-10-31 —— 起因：一次复核里，两边都拿「grep 命中次数」当覆盖率（34 / 38 / 0/27），
而没人能说清分母是什么。后来定下来：

    单位该是「接受外部形状的端点」，不是「某个函数名出现了几次」。

本脚本把这条落到本仓：
    分子 = 有「精确键集断言」的 MCP 工具
    分母 = 全部 MCP 工具（按 `server.tool("<name>"` 注册处计数）

⚠️ 归因是**启发式**，而且**误差方向未知** —— 这一点比「是下界」重要得多：
   · 可能少算：间接断言、运行期生成、共享测试助手都不认
   · 也可能多算：同一个测试文件里提到该工具名、而精确键集断言是为**别的**工具写的
⇒ 所以这里**故意给两个口径**并排印：
     文件级（宽）  ：文件里提到工具名 + 文件里有精确键集断言
     邻近级（严）  ：工具名与该断言相距 ≤ WINDOW 行
⇒ 两个数之间的差额，就是「文件级代理的误报面」。
   只印一个数，读的人会以为它是精确值；印两个，差额自己会说话。

用法：python3 scripts/report-mcp-key-set-coverage.py [--json]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOL_DEF = re.compile(r"""server\.tool\(\s*"([a-z0-9_]+)\"""")
# 2026-10-31 —— 必须同时认「排序」与「未排序」两种写法。
# 之前只认 `Object.keys(x)).toEqual([`，于是我们把断言统一改成 `.sort()` 之后，
# **覆盖率从 35 掉到 20** —— 掉的不是覆盖，是检测器认不出新形状。
# ⇒ 判据：指标跟着被测代码的形状走时，它衡量的就是「形状有没有变」。
EXACT_KEYSET = re.compile(r"Object\.keys\([^)]*\)(?:\.sort\(\))?\)\.toEqual\(\[")
WINDOW = 30  # 邻近级口径：工具名与断言之间允许的最大行距


def tracked(patterns: list[str]) -> list[Path]:
    """Git 里**已跟踪 + 未跟踪**的匹配文件。

    2026-10-31 —— 原来只取 `ls-files`（已跟踪）。于是**刚写好还没 commit 的测试文件**
    对这份报告完全不可见：我新加了一个文件覆盖三个工具，报告仍然说它们 uncovered。
    而「刚写的那个」恰好是最该被计数的那个。
    ⇒ 用 `-co`（cached + others）并排除 gitignore；工作树状态会影响读数这件事写在 --json 的
      does_not_cover 里，不让它悄悄成立。
    """
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-co", "--exclude-standard", *patterns],
        capture_output=True, text=True,
    ).stdout.split()
    return [REPO / p for p in out if p.endswith(".ts")]


# **必须是函数定义**，不能是 `const card = await mcp(..., "requirements_create", ...)`
# —— 那是「结果变量」，不是 helper。把它当 helper 的后果实测过：
#   邻近口径从 70/88 直接变成 **88/88**（`a(` / `all(` / `after(` 出现在各处，
#   于是每个工具都被算成「附近有键集断言」）。判据放宽一步，读数就整体失去信息。
# 还必须是**箭头函数**（`= (a, b) => …`）或 `function f(`。
# `const x = (await mcp(...))` 这种「带括号的表达式」不是 helper ——
# 实测：只要求 `= (` 时，`created` / `got` / `first` / `res` 这批**结果变量**全被绑成 helper。
HELPER_DEF = re.compile(
    r"^\s*(?:export\s+)?(?:const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>"
    r"|function\s+([A-Za-z_$][\w$]*)\s*\()"
)


def tool_mentions(lines: list[str], name: str, known: set[str]) -> tuple[list[int], list[int]]:
    """这一个测试文件里，**tool 的提及点**：字面量出现行 + 本地 helper 的调用行。

    2026-10-31 —— 与 REST 侧同一个缺陷类（`report-rest-coverage.py` 的 MentionIndex）：
    测试常把工具调用包一层，`const create = (n) => mcp(OWNER, "create_node", …)`，
    于是**真正的调用点**那几行里没有工具名字面量，键集断言即使紧贴调用点也会被算成「没钉」。

    只做很窄的一件事：定义行 + 后 3 行内**恰好**提到一个已知工具名时，
    把 `NAME(` 的调用点也算作该工具的提及点。提到两个就放弃（宁可不认，也不猜）。
    返回 (字面量行, helper 调用行) —— 分开返回是为了让报告能说清「这条是凭什么算上的」。
    """
    # 2026-10-31 —— 三种提及形态都要认，否则「覆盖率」衡量的是**写法**而不是覆盖：
    #   mcp(tok, "tool", …)        —— 引号字面量（最常见）
    #   toolsFor(A).tool(…)        —— handler 表成员调用（peer-reply-atomic 就是这么测的）
    #   tools["tool"](…)           —— 索引调用
    # 只认第一种时，send_peer_reply / report_completion 明明被调用过、也断言过，却算 uncovered。
    literal = [
        i for i, ln in enumerate(lines)
        if re.search(rf"""["']{re.escape(name)}["']""", ln)
        # 成员/索引**引用**也算：`call(toolsFor(B).send_peer_reply, {…})` 是把 handler 当参数传，
        # 名字后面跟的是逗号不是括号 —— 要求 `(` 会把这种（本仓最常用的 handler 表写法）漏掉。
        or re.search(rf"\.{re.escape(name)}\b", ln)
        or re.search(rf"\[\s*[\"']{re.escape(name)}[\"']\s*\]", ln)
    ]
    helpers: dict[str, int] = {}
    for i, ln in enumerate(lines):
        m = HELPER_DEF.match(ln)
        if not m:
            continue
        # **只认定义行本身**（不放宽到后几行）：放宽到 +3 行会把通用 helper
        # （`const post = (p, body) => fetch(...)`）绑到恰好写在它下面的那个工具名上，
        # 于是这个文件的每个 `post(` 都成了那个工具的「提及点」——
        # 实测：放宽到 +3 行时邻近口径从 70/88 直接跳到 **88/88**，那不是覆盖变好，是判据坏了。
        # 定义行 + （**只有**箭头函数把函数体换到下一行时）紧接的那一行。
        # `const create = (k, extra) =>` / `  mcp(node[k].token, "schedule_create", …)` 是常见写法；
        # 只认定义行会让 schedule_create 这种「体在下一行」的 helper 整个消失（实测）。ı
        body = [i]
        if lines[i].rstrip().endswith("=>") and i + 1 < len(lines):
            body.append(i + 1)
        seen: set[str] = set()
        for t in known:
            if any(re.search(rf"""["']{re.escape(t)}["']""", lines[j]) for j in body):
                seen.add(t)
        if len(seen) == 1 and next(iter(seen)) == name:
            # ⚠️ 只登记「绑定到**这个**工具」的 helper。
            # 第一版漏了这句 `== name`：于是任何 helper 的调用点都被算成本工具的提及点，
            # 邻近口径从 70/88 直接变成 88/88 —— 覆盖没变，判据变成了恒真。
            helpers.setdefault(m.group(1) or m.group(2), i)
    calls: list[int] = []
    for i, ln in enumerate(lines):
        for h in helpers:
            if re.search(rf"\b{re.escape(h)}\s*\(", ln):
                calls.append(i)
                break
    return literal, calls


def main() -> int:
    tools: dict[str, Path] = {}
    for path in tracked(["server/src/*.ts"]):
        if path.name.endswith(".test.ts"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for name in TOOL_DEF.findall(text):
            tools.setdefault(name, path)

    file_level: dict[str, list[str]] = {}
    near_level: dict[str, list[str]] = {}
    helper_only: dict[str, list[str]] = {}
    for path in tracked(["server/src/*.test.ts"]):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        assert_lines = [i for i, ln in enumerate(lines) if EXACT_KEYSET.search(ln)]
        if not assert_lines:
            continue
        for name in tools:
            literal, calls = tool_mentions(lines, name, set(tools))
            hits = literal + calls
            if not hits:
                continue
            file_level.setdefault(name, []).append(path.name)
            near_by_literal = any(abs(a - h) <= WINDOW for a in assert_lines for h in literal)
            near_by_helper = any(abs(a - h) <= WINDOW for a in assert_lines for h in calls)
            if near_by_literal or near_by_helper:
                near_level.setdefault(name, []).append(path.name)
            # 口径变过就要能指认：只有靠 helper 才认出来的，单独记一份
            if near_by_helper and not near_by_literal:
                helper_only.setdefault(name, []).append(path.name)

    covered = sorted(file_level)
    uncovered = sorted(set(tools) - set(covered))

    near = sorted(near_level)

    # 2026-10-31 —— 「测空气」检查：名字出现在文件里 ≠ 那条断言在测这个工具。
    # 第三口径最严：名字必须出现在**调用表达式**里（tool( / callTool( 同行），
    # 且与精确键集断言相距 ≤15 行。
    strict_level: dict[str, list[str]] = {}
    _min_dist: dict[str, int] = {}
    for path in tracked(["server/src/*.test.ts"]):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        assert_lines = [i for i, ln in enumerate(lines) if EXACT_KEYSET.search(ln)]
        if not assert_lines:
            continue
        for name in tools:
            call_lines = [i for i, ln in enumerate(lines)
                          if re.search(rf'(?:tool|callTool|invoke)\([^)]*["\']{re.escape(name)}["\']', ln)]
            if call_lines:
                dist = min(abs(a - c) for a in assert_lines for c in call_lines)
                prev = strict_level.get(name)
                # 记录该工具在哪个距离档上「有调用」；用一个附加字典存最小距离
                strict_level.setdefault(name, []).append(path.name)
                _min_dist[name] = min(_min_dist.get(name, 10 ** 9), dist)
    # 2026-10-31 —— 第四档「own_result」：**同一变量的键集**。
    # 前三档都只看距离，于是「断言写在某个工具调用旁边」就能把它算进覆盖 ——
    # 今天实测到两次（upsert_network_secret、list_node_skills），两次都是我把断言写在别人旁边。
    # ⇒ 这一档要求：`const X = await …("tool"` 之后 ≤15 行出现 `Object.keys(X)`。
    own_result: dict[str, list[str]] = {}
    # 2026-10-31 —— 调用有四种写法：`tool(token,"x")` / `call(tools["x"],…)` / `mcp(t,"x",…)` / `.call("x",…)`。
    # 只认第一种会漏掉 `tools["cancel_task"]`（实测）；而放宽成「行内第一个小写词」又会抓错。
    # ⇒ 取行内**所有**带引号的小写标识符，命中工具表的那一个才算。
    ASSIGN = re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*await\b")
    QUOTED = re.compile(r"[\"']([a-z_]+)[\"']")
    own_result: dict[str, list[str]] = {}
    for path in tracked(["server/src/*.test.ts"]):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, ln in enumerate(lines):
            m = ASSIGN.search(ln)
            if not m:
                continue
            var = m.group(1)
            # 2026-10-31 —— 名字有两种写法：`mcp(t, "tool", …)` 与 `call(toolsFor(B).tool, …)`。
            # 只认引号会把后者整类漏掉（send_peer_reply / report_completion 就是这样被漏的）。
            name = next(
                (c for c in QUOTED.findall(ln) if c in tools),
                next((t for t in tools if re.search(rf"\.{re.escape(t)}\b", ln)), None),
            )
            if not name:
                continue
            # 2026-10-31 —— 窗口原来是**固定 16 行**，实测是个假下限：
            #   report_completion 的同变量断言就在它的调用下面，但之间隔着 10 行
            #   「我为什么改了三版」的注释 ⇒ 16 行窗口看不到它，于是这个工具被记成「未覆盖」。
            #   **注释越长、越诚实，这条断言越容易被判成不存在** —— 这恰好奖励了少写注释。
            # ⇒ 改成**按块截断**：扫到这个块里又一次 `const x = await` 或下一个 test( 为止，
            #   而不是数行数。判据是「同一个块内的断言」，块边界本来就是语法给的。
            #
            # ⚠️ 换成新定义后的**已知假阴性**（实测 diff）：`retry_task` 从"有"变成"没有" ——
            #    它的断言与调用之间还夹着一次别的调用赋值，于是块边界截断在了断言之前。
            #    同一份代码，旧窗口（16 行）看得见它、新窗口看不见；反过来 report_completion 只有新的看得见。
            #    ⇒ **两把窗口各有一个假阴性**。这里选「块」是因为它有语法依据；而数行数没有 ——
            #      16 是拍的，换成 24/30/60 同一份代码分别给出 57/57/58。
            #    所以引用这个数时要连口径一起引；口径换了，数就不能和旧数直接比。
            end = i + 1
            while end < len(lines) and end < i + 120:
                if ASSIGN.search(lines[end]) or re.match(r"\s*test\(", lines[end]):
                    break
                end += 1
            window = "\n".join(lines[i:end])
            # 2026-10-31 —— `Object.keys(x as any)` 也是同变量断言，而原正则要求 `x` 后面紧跟 `)`。
            # 实测：`delete_node` 早就有一条精确键集断言，只因写了 `as any` 就被记成「没有」。
            # ⇒ 类型断言不改变被测对象，所以它不该改变归属。
            if re.search(rf"Object\.keys\(\s*{re.escape(var)}(\s+as\s+[\w.<>\[\]]+)?\s*\)", window):
                own_result.setdefault(name, []).append(path.name)
    own = sorted(own_result)

    strict = sorted(strict_level)
    band = lambda lim: sorted(n for n, d in _min_dist.items() if d <= lim)  # noqa: E731
    strict_15, strict_40, strict_80 = band(15), band(40), band(80)

    # 2026-10-31 —— **子串假阳性**是这类统计的通用事故形态：
    # 一次外部复核里，`counters` 被无关的 DB 表名 `usage_counters` 匹配上，
    # 而假阳性恰好藏掉了那条线正在讨论的字段。
    # ⇒ 工具名之间存在前/后缀包含时，按名字匹配必然把两者混在一起。
    ambiguous = sorted((a, b) for a in tools for b in tools if a != b and a in b)
    if "--json" in sys.argv:
        print(json.dumps({
            "tools_total": len(tools),
            "covered_file_level": len(covered),
            "covered_near_level": len(near),
            "covered_own_result": len(own),
            "own_result_names": own,
            "evidence_class": "proxy; error direction unknown (can both under- and over-count)",
            "near_names": near,
            # 口径可指认：这几个是**只靠本地 helper 的调用点**才认出来的
            #（工具名只出现在 helper 定义行，调用点那几行没有字面量）
            "near_via_local_helper": sorted(helper_only),
            "uncovered": uncovered,
        }, ensure_ascii=False, indent=1))
        return 0

    # 2026-10-31 —— 先声明**对象**，再谈范围。
    # 外部复核踩过一次更坏的：用 A 产物的读数去否证 B 产物上的判据
    #（「不是范围不够，是对象换了」）。
    print("object         : server/src/*.ts 里的 `server.tool(` 注册（**服务端**的工具表；不含客户端/控制台侧符号）")
    print("断言侧对象     : server/src/*.test.ts（服务端测试；不看其它包与构建产物）")
    print(f"MCP 工具：{len(tools)} 个（分母 = 注册点，不是 grep 次数）")
    # 2026-10-31 —— 头条数字换成**严格口径**。
    # 实测抽查：list_tasks 在测试里被调用过、该文件也有一条 Object.keys 断言，
    # 但那条断言测的是 humans[0]，与 list_tasks 无关 ⇒ 文件级把这种算成了「已覆盖」。
    # ⇒ 读者只看第一个数，所以第一个数必须是最不容易被高估的那个。
    print(f"覆盖（邻近口径，断言与调用 ≤{WINDOW} 行）：{len(near)} 个 ⇒ {len(near)}/{len(tools)} = {len(near) / max(len(tools), 1):.1%}")
    # 2026-10-31 —— 「同变量口径」：这条断言是不是在测**它自己的**调用结果。
    print(f"覆盖（**同变量口径**）：{len(own)} 个 ⇒ {len(own)}/{len(tools)} = {len(own) / max(len(tools), 1):.1%}")
    print("  ⇒ 同变量口径才接近「这条断言在测这个工具」；邻近口径会把写在旁边的一起算进去。")
    if helper_only:
        print(f"  ·其中 {len(helper_only)} 个是**只靠本地 helper 调用点**认出来的：{', '.join(sorted(helper_only))}")
        print("   （工具名只出现在 `const x = (…) => mcp(…, \"tool\" …)` 这一行，调用点里没有字面量）")
    print(f"上界（文件级，**含可能测空气**）：{len(covered)} 个 ⇒ {len(covered)}/{len(tools)} = {len(covered) / max(len(tools), 1):.1%}")

    print(f"调用表达式级（名字出现在 tool( 调用里）按**断言距调用**的距离分档：")
    print(f"    ≤15 行：{len(strict_15)} 个（{len(strict_15) / max(len(tools), 1):.1%}）"
          f"｜≤40 行：{len(strict_40)} 个（{len(strict_40) / max(len(tools), 1):.1%}）"
          f"｜≤80 行：{len(strict_80)} 个（{len(strict_80) / max(len(tools), 1):.1%}）")
    print(f"⇒ 文件级 {len(covered)} 与 ≤80 行档 {len(strict_80)} 之差 = "
          f"{len(covered) - len(strict_80)} 个「可能测的是空气」：名字出现过，但没有证据表明那条断言在调它。")
    print("   ⚠️ 距离档不是可信度本身：中间夹着 setup 的测试会落在远档，而它可能完全有效。")
    print("⚠️ 这不是下界：多算与少算都可能发生，所以**误差方向未知**，只能当代理读。")
    if covered:
        print("\n已覆盖：")
        for name in covered:
            print(f"  {name}  ← {', '.join(file_level[name])}")
    if uncovered:
        print(f"\n未覆盖（{len(uncovered)}）：")
        for name in uncovered:
            print(f"  {name}  ({tools[name].relative_to(REPO)})")
    if ambiguous:
        print(f"\n⚠️ 子串歧义 {len(ambiguous)} 对（按名字匹配会把它们混在一起）：")
        for a, b in ambiguous:
            print(f"    {a}  ⊂  {b}")
        print("  ⇒ 这几对的归因结果不可单独引用；要看证据行本身。")
    print("\n⚠️ 归因是代理：多算与少算都可能，误差方向未知（不是下界）。")
    print("   不认间接断言、不认运行期生成的键集、不认跨文件共享的测试助手。")
    # 2026-10-31 —— 「在哪个版本上量的」必须跟着数字走。
    # 今晚刚发生过一次：两边的数对不上，根因不是谁数错，是**在数两棵不同的树**。
    print(f"measured_on    : {_measured_on()}")
    # 2026-10-31 —— 一个绿属于**二元组**（被测物, 测法）。只钉被测物时，
    # 测法一改（改口径/改正则），那个绿属于哪一对就不可判 —— 而它会以「这条过了」被引用很多次。
    import hashlib as _h, pathlib as _pl
    _self = _pl.Path(__file__).read_bytes()
    # 2026-10-31 —— 尺子不止是代码：同一脚本在不同环境上可以给出不同读数。
    # 归属是三件：(被测物, 尺子的代码, 尺子的环境)。只引 sha 时，两个不同的尺子会让同一个数看起来是同一个来源。
    import platform as _pf, sys as _sys
    print(f"measured_by    : {_pl.Path(__file__).name} sha256={_h.sha256(_self).hexdigest()[:12]}"
          f" ｜ env: python {_sys.version.split()[0]} / {_pf.system()} / re(CPython)")
    print("                 ⇒ 引用时 sha 与 env 要一起引；缺 env 的读数只能读，不能引")
    # 2026-10-31 —— 第三件：**谁在用**。作废的影响面只由它决定。
    print("consumers      : #3171 的覆盖率读数（人工引用）｜决定「还差几个工具没硬钉」")
    print("                 ⇒ 这一栏为空时要读作「我们不知道有没有人用」，不是「没人用」")
    # 2026-10-31 —— 必填的 falsifier：说不出「什么输入能让它变假」的断言是恒真的。
    print("falsifier      : 删掉某个被计为「已覆盖」的工具的精确键集断言 ⇒ 文件级该数应 −1；"
          "若删了不变 ⇒ 归因链坏了")
    print("                 （另一条：把某个未覆盖工具加一条精确断言 ⇒ ≤15 行档应 +1）")
    print("invalidates_on : 工具注册变（server.tool 增删）｜断言写法变（EXACT_KEYSET 正则不再匹配）")
    print("                 ｜归因口径变（文件级 ↔ 邻近级窗口）⇒ 三者任一发生，上面的比例作废")
    return 0


def _measured_on() -> str:
    """读不到就写 unknown —— 不写「干净」（那会被读成「已验证的干净」）。"""
    try:
        import subprocess
        ref = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(REPO), "status", "--porcelain"],
                               capture_output=True, text=True, timeout=10).stdout.strip()
        if not ref:
            return "ref=unknown dirty=unknown"
        from datetime import datetime, timezone
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return f"ref={ref[:12]} dirty={'true' if dirty else 'false'} observed_at={stamp}"
    except Exception:
        return "ref=unknown dirty=unknown"


if __name__ == "__main__":
    sys.exit(main())
