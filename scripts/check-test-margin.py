#!/usr/bin/env python3
"""单条测试的「余量」必须能被看见 —— 默认超时**不写在源码里**。

## 为什么（#1627）

bun 的单条超时默认值**不出现在任何测试源码里**。于是：

  · 源码里 grep `timeout` 一无所获，看起来「这条测试没有超时问题」；
  · 一台慢 1.8 倍的 runner 会让贴着上限的测试变红，报错读起来**和真缺陷一模一样**
    —— `[20832.89ms]` 的**下一行**才是 `^ this test timed out after …ms.`。

2026-08-31 一天里三批红（`agent-node unit`、`test686-rest-shape-golden`、以及一个
**只改两个 .md 的纯文档 PR**）全是这个形状。

仓库里已经有 `L1-TIMING v1`（`scripts/qa.sh`），但它是**套件**粒度；
而这个失效模式发生在**单条测试**上 —— 套件级仪表看不见它。

## 判据：占**有效**超时的百分比

「有效超时」= 该条自己声明的 timeout，否则它所在 `describe` 声明的，
否则运行器的**实测**默认（`resolve_default_ms()`，不是抄文档的）。

🔴 下面三条都不是洁癖，都是本脚本**踩过的坑**（#1309 评审逐条点出）：

  ① 拿某个「默认值」当分母去排所有测试，会把一条**自己声明了 `}, 60_000)`** 的
     测试（实测 18069ms）报成「90.3%、危险」——它真实余量是 3.3 倍。
     **任何忽略声明值的排序，都会把已经修好的测试误报成高危。**
  ② 把隐式默认猜成 20000ms 是**错的**：钉死的 bun 1.3.14（`oven/bun:1.3.14`、
     仓库无 `bunfig.toml`、`qa.sh` 也不传 `--timeout`）实测是 **5000ms**
     （加不加 `--coverage` 都是 5000）。按 20000 去算，2.5–5s 的**无声明**测试
     会被报成 12.5%–25% 而静默略过 —— **恰好是本报告要抓的那一段**。
  ③ 只认 `>= 1000` 的声明值，会把 `test("x", () => {…}, 500)` 这类**合法的短
     超时**丢掉：450ms/500ms 该报 90%，当时报 2.25%（分母退回默认）。
  ④ 钩子超时失败（`^ a beforeEach/afterEach hook timed out for this test.`）
     记录行给的是**测试名**和它**实际用满**的那个超时；拿测试自己的有效超时
     （5000ms）当分母，会把一个把 30s 钩子超时用满的测试报成 600%。

## 用法

    python3 scripts/check-test-margin.py --logs '/tmp/qa-l0-*.log' '/tmp/qa-l1-*-run.log'
    python3 scripts/check-test-margin.py --logs job.log --pct 50
    python3 scripts/check-test-margin.py --logs job.log --fail     # 有贴上限的 → 退出 1
    python3 scripts/check-test-margin.py --selftest                # 用内嵌夹具自证（不读日志）

默认 **report-only**（退出 0）；阈值用 `--pct` 或环境变量 `TEST_MARGIN_PCT` 覆盖。
默认超时用 `--default-ms` 或 `TEST_MARGIN_DEFAULT_MS` 覆盖。
`--logs` 可以给任意文本（GitHub job 全文也可以 —— 它就是所有 per-suite 日志的拼接）。

## 输出

一行固定形状，跨 run 可比，与 `L1-TIMING v1` 同族（**字段顺序定了就别改**，
改了之前所有 run 的日志就对不上）：

    TEST-MARGIN v1 tests=<n> hooks=<m> threshold=50% near=<k> slowest=<slug>=<pct>%,...

`near>0` 时再逐条打印 `耗时 / 有效超时 / 占比 / 源码位置`。

## 覆盖边界（诚实声明）

只能看见**跑过的**测试，而且只解析**静态可读**的标题（模板字面量里含 `${}` 的
标题取不到，会退回**实测默认** —— 这是**偏保守**的方向：只会多报，不会漏报；
`test.skipIf(c)(…)` 这种**柯里化**形式也取不到，同样退回默认）。
`tests=` 字段就是本次样本量，判读前先看它。
"""

from __future__ import annotations

import argparse
import glob as globlib
import os
import re
import shutil
import sys
import tempfile

ANSI = re.compile(r"\x1b\[[0-9;]*m")
JOBTS = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ")
# bun: `(pass) describe > test [123.45ms]` / `(fail) (unnamed) [5490.92ms]`
TIMING = re.compile(r"^\s*\(?\b(pass|fail|skip)\)?\s+(?P<name>.+?)\s+\[(?P<ms>\d+(?:\.\d+)?)ms\]\s*$")

# 修饰器（`.only` / `.skip` / `.skipIf` / `.each` …）与**柯里化**的第二层调用：
#   `test.skipIf(cond)("title", …)`、`test.each([[1,2]])("t %d", …)`。
# `_CURRY` 只允许同一行、括号不嵌套的写法；取不到就退回默认（**偏保守**：只会多报）。
_MOD = r"(?:\.[A-Za-z_$][\w$]*)?"
# 柯里化的第二层调用：`test.skipIf(cond)("title"…)` / `test.each([…])("title"…)` ——
# 条件本身也在同一行，所以 `_CURRY` 要吃下 `cond)` **和** 紧接着的那个 `(`。
_CURRY = r"(?:[^()\n]*\)\s*\(\s*)?"
TEST_START = re.compile(
    rf"^(?P<ind>\s*)(?:test|it){_MOD}\({_CURRY}"
    r"(?:\"(?P<d>[^\"]{1,300})\"|'(?P<s>[^']{1,300})'|`(?P<b>[^`$]{1,300})`)"
)
DESC_START = re.compile(
    rf"^(?P<ind>\s*)describe{_MOD}\({_CURRY}"
    r"(?:\"(?P<d>[^\"]{1,300})\"|'(?P<s>[^']{1,300})'|`(?P<b>[^`$]{1,300})`)"
)
# `}, 60_000);` 或 `});` —— 缩进必须与 opener 相同，否则不动栈（防止内层闭包打乱对齐）
CLOSE = re.compile(r"^(?P<ind>\s*)\}\s*(?:,\s*(?P<ms>[0-9][0-9_]*)\s*)?\)")
# 🔴 **单行**形式：`test("t", () => { … }, 500);` —— opener 与 closer 在同一行，
#    `CLOSE` 要求行首是 `}`，所以它**永远**看不到这一种（#1309 评审给的见证原文
#    正是这个写法：450ms/500ms 被算成 450/5000 = 9%）。
SELF_CLOSED_TMO = re.compile(r"(?:\}|\))\s*,\s*(?P<ms>[0-9][0-9_]*)\s*\)\s*;?\s*$")
# 单行且**没有**声明：`test("t", () => { … });` / `test.todo("t")` —— 同样必须在
# 原地闭掉，否则会留下一个永远弹不掉的栈帧，把后面的 `}, N)` 错配到它身上。
SELF_CLOSED = re.compile(r"\)\s*;?\s*$")

# 🔴 默认超时是**测出来的**，不是抄文档的。测量配方（钉死的 bun 1.3.14，与
#    `.github/workflows/qa.yml` 里 `bun-version: 1.3.14` 同一版本）：
#
#      docker run --rm -v "$PWD:/m" -w /m oven/bun:1.3.14 bash -lc '
#        printf "import { test } from \"bun:test\";\n\
#        test(\"implicit default\", async () => { await new Promise(() => {}); });\n" > t.test.ts
#        bun test t.test.ts'
#
#    ⇒ `(fail) implicit default [5000.01ms]` + `^ this test timed out after 5000ms.`
#    加 `--coverage` 同样 5000.01ms。仓库无 `bunfig.toml`，`qa.sh` 的 L0/L1
#    都不传 `--timeout` ⇒ 真实生效的就是这个 5000ms。
#    钩子的隐式超时同一次测量里也验证过（`beforeEach` 不声明超时 ⇒ 5000.01ms）。
PINNED_BUN_DEFAULT_MS = 5_000
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".next", "coverage"}
DEFAULT_PCT = 50.0
# `^ a beforeEach/afterEach hook timed out for this test.`（bun 1.3.14 实测原文）
HOOK_TIMEOUT_MSG = re.compile(r"hook timed out")


def clean(line: str) -> str:
    return JOBTS.sub("", ANSI.sub("", line)).rstrip()


def resolve_default_ms(root: str) -> int:
    """隐式默认超时：环境变量 > `bunfig.toml` 的 `[test] timeout` > 实测值。

    只要仓库里出现了 `bunfig.toml`，就不能装作没看见 —— 那会让分母又变成猜的。
    """
    env = os.environ.get("TEST_MARGIN_DEFAULT_MS")
    if env:
        try:
            return int(env)
        except ValueError:
            pass
    try:
        cfg = open(os.path.join(root, "bunfig.toml"), encoding="utf-8", errors="replace").read()
    except OSError:
        return PINNED_BUN_DEFAULT_MS
    m = re.search(r"^\[test\][\s\S]*?^\s*timeout\s*=\s*([0-9][0-9_]*)\s*$", cfg, re.M)
    return int(m.group(1).replace("_", "")) if m else PINNED_BUN_DEFAULT_MS


def parse_timings(text: str):
    """→ [(status, bun_name, ms)]；bun_name 形如 `describe > describe > test`。"""
    out = []
    for raw in text.split("\n"):
        m = TIMING.match(clean(raw))
        if m:
            out.append((m.group(1), m.group("name").strip(), float(m.group("ms"))))
    return out


def parse_hook_failures(text: str) -> set[str]:
    """→ 因**钩子超时**而失败的记录名。

    bun 1.3.14 实测（两种都测过）：

        (fail) hook control > body that passes [30000.02ms]
          ^ a beforeEach/afterEach hook timed out for this test.

    记录行给的是**测试名**，ms 是钩子**实际用满**的超时（声明 30s ⇒ 30000.02ms；
    不声明 ⇒ 5000.01ms）。分母只能用这个 ms —— 拿测试自己的有效超时去算，
    会把「把 30s 钩子用满」报成 600%（#1309 评审第 ④ 条）。
    """
    out: set[str] = set()
    last_fail: str | None = None
    for raw in text.split("\n"):
        line = clean(raw)
        m = TIMING.match(line)
        if m:
            last_fail = m.group("name").strip() if m.group(1) == "fail" else None
            continue
        if last_fail and HOOK_TIMEOUT_MSG.search(line):
            out.add(last_fail)
            last_fail = None
    return out


def index_source(root: str):
    """扫一遍源码：标题 → (有效超时ms, 'file:line')。

    两次遍历：先记 describe 的 (start, end, timeout)，再按行号把最内层
    describe 的超时套到它里面的测试上 —— 因为 describe 的 `}, N)` 出现在
    它的测试**之后**，正向走一遍是拿不到的。
    """
    index: dict[str, tuple[int | None, str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if not (fn.endswith(".test.ts") or fn.endswith(".test.tsx") or fn.endswith(".test.js")):
                continue
            path = os.path.join(dirpath, fn)
            try:
                lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
            except OSError:
                continue
            rel = os.path.relpath(path, root)
            frames: list[dict] = []
            tests: list[dict] = []
            descs: list[dict] = []
            for i, line in enumerate(lines):
                mt = TEST_START.match(line)
                md = None if mt else DESC_START.match(line)
                if mt or md:
                    m = mt or md
                    ind = len(m.group("ind"))
                    st = SELF_CLOSED_TMO.search(line)
                    sc = bool(st) or bool(SELF_CLOSED.search(line))
                    if not sc:
                        # 多行形式：入栈，等它的 `}, N)` / `});` 收尾
                        frames.append({"kind": "test" if mt else "describe", "ind": ind,
                                       "line": i, "timeout": None,
                                       "title": (m.group("d") or m.group("s") or m.group("b")) if mt else None})
                        continue
                    # 🔴 单行形式：opener 与 closer 在同一行 ⇒ 就地解析，不入栈
                    #    （入栈会留下永远弹不掉的帧，把后面的 `}, N)` 错配过来）。
                    if mt:
                        val = int(st.group("ms").replace("_", "")) if st else 0
                        tests.append({"kind": "test", "ind": ind, "line": i,
                                      "title": m.group("d") or m.group("s") or m.group("b"),
                                      "timeout": val if val >= 1 else None, "end": i})
                    # 单行 describe 里不可能还有别的行 ⇒ 直接忽略
                    continue
                mc = CLOSE.match(line)
                if mc:
                    ind = len(mc.group("ind"))
                    # 🔴 **不**强制弹更深的帧（原来是 `while frames[-1]["ind"] > ind:
                    #    frames.pop()`）。那一步会让「缩进恰好是 0 的 `});`」把整片
                    #    栈弹掉 —— 而本仓 `runtime.test.ts:1094/1109` 就有这种行：
                    #    用例体里内嵌了一段**要构建的源码**（模板字面量），里面
                    #    `});` 就在第 0 列。后果：1065 行那条 `test.skipIf(...)` 的
                    #    声明帧被无声弹掉 ⇒ 它永远进不了 `tests` ⇒ 30_000 丢失。
                    #    缩进不等就**不动栈**，这正是本文件上面那条原则。
                    if frames and frames[-1]["ind"] == ind:
                        fr = frames.pop()
                        val = int(mc.group("ms").replace("_", "")) if mc.group("ms") else 0
                        # 🔴 `>= 1`，不是 `>= 1000`：bun 收毫秒，`test("x", fn, 500)`
                        #    是**合法**的短超时（#1309 评审第 ③ 条）。0/缺省才算没声明。
                        tmo = val if val >= 1 else None
                        fr["timeout"] = tmo
                        if fr["kind"] == "test":
                            fr["end"] = i
                            tests.append(fr)
                        else:
                            fr["end"] = i
                            descs.append(fr)
            for fr in frames:
                # 没有配到 closer 的帧（例如 `test(` 后面跟的不是静态标题）同样归入 ——
                # 拿不到声明就去用默认/describe，方向是**多报**而不是漏报。
                if fr["kind"] == "test":
                    fr.setdefault("timeout", None)
                    fr["end"] = fr["line"]
                    tests.append(fr)
                else:
                    # describe 也要进去，否则它下面的测试会丢掉继承
                    fr["end"] = len(lines)
                    descs.append(fr)
            for t in tests:
                eff = t.get("timeout")
                if eff is None:
                    encl = [d for d in descs if d["line"] < t["line"] < d["end"] and d["timeout"]]
                    if encl:
                        eff = max(encl, key=lambda d: d["line"])["timeout"]
                loc = f"{rel}:{t['line'] + 1}"
                title = t["title"]
                prev = index.get(title)
                if prev is None or (eff or 0) > (prev[0] or 0):
                    index[title] = (eff, loc)      # 同名多条取最大（偏保守：只会少报风险）
    return index


def slug(s: str, width: int = 34) -> str:
    s = s.split(" > ")[-1].strip()
    s = re.sub(r"[^0-9A-Za-z_.\-]+", "_", s).strip("_")
    return (s[:width] or "unnamed")


# ── 自证夹具 ────────────────────────────────────────────────────────────────
# 🔴 夹具是**故意**这样设计的:一个 describe **没有**声明超时、另一个**有**,
#    而且有超时的那个把自己的 `}, 30_000);` 放在它的测试**之后**。
#    这正是唯一需要两趟遍历的地方 —— 任何「取下一个 `}, N)`」的朴素实现,
#    都会把 30_000 错记到前一个 describe 的测试上。断言里把 5 个分母全钉死,
#    所以那种退化会在这里炸,而不是在慢 runner 上炸。
SELFTEST_FIXTURE = """import { describe, test } from "bun:test";
describe("margin control", () => {
  test("no declared timeout here", () => {
    expect(1).toBe(1);
  });
  test("declared but tiny", () => {
    expect(1).toBe(1);
  }, 4_000);
  test("short timeout", () => {
    expect(1).toBe(1);
  }, 500);
  test("one line declared", () => { expect(1).toBe(1); }, 500);
  test.skipIf(true)("curried declared", () => {
    expect(1).toBe(1);
  }, 9_000);
  test("one line no declaration", () => { expect(1).toBe(1); });
  test("declares twenty", () => {
    expect(1).toBe(1);
  }, 20_000);
  test("safely fast", () => {
    expect(1).toBe(1);
  });
});
describe("inherited control", () => {
  test("inherits the describe timeout", () => {
    expect(1).toBe(1);
  });
}, 30_000);
"""

SELFTEST_LOG = """(pass) margin control > no declared timeout here [19000.00ms]
(pass) margin control > declared but tiny [3800.00ms]
(pass) margin control > short timeout [450.00ms]
(pass) margin control > one line declared [450.00ms]
(pass) margin control > curried declared [8000.00ms]
(pass) margin control > one line no declaration [1000.00ms]
(pass) margin control > declares twenty [4000.00ms]
(pass) margin control > safely fast [100.00ms]
(pass) inherited control > inherits the describe timeout [21000.00ms]
(pass) (unnamed) [4900.00ms]
"""

# 钩子超时的**真形状**（bun 1.3.14 实测）：记录行是**测试名** + 它用满的
# 那个超时，下一行才是 `hook timed out`，里面**没有数字**。
SELFTEST_HOOK_LOG = """(fail) hook control > body passes [30000.02ms]
  ^ a beforeEach/afterEach hook timed out for this test.
"""


def evaluate(rows, index, pct, default_ms=PINNED_BUN_DEFAULT_MS, hook_failures=frozenset()):
    """把「逐条耗时 × 有效超时」算成裁决结果。main 与 selftest 走**同一条**路径。"""
    # 同名去重取最大：同一个文件被多个套件跑时会重复出现
    best: dict[str, float] = {}
    hook_ms = 0.0
    hooks = 0
    for _st, name, ms in rows:
        if name.strip() in ("(unnamed)", ""):
            # `(unnamed)` 记录取不到标题 ⇒ 只能按隐式默认判（实测 5000ms）。
            hooks += 1
            hook_ms = max(hook_ms, ms)
            continue
        best[name] = max(best.get(name, 0.0), ms)

    entries: list[tuple[float, int, float, str, str]] = []
    for name, ms in best.items():
        if name in hook_failures:
            # 撞上钩子超时 ⇒ 分母**就是**它撞上的那个超时 ⇒ 100%。
            # 这是唯一不用猜的读法（见 parse_hook_failures）。
            entries.append((ms, ms, 100.0, "(hook timeout hit)", name))
            continue
        title = name.split(" > ")[-1].strip()
        eff, loc = index.get(title, (None, "?"))
        eff = eff or default_ms
        entries.append((ms, eff, 100.0 * ms / eff, loc, name))
    if hook_ms:
        entries.append((hook_ms, default_ms, 100.0 * hook_ms / default_ms,
                        "(hook)", "(unnamed hook — beforeEach/afterEach)"))
    near = sorted([e for e in entries if e[2] >= pct], key=lambda r: -r[2])
    return best, hooks, entries, near


def selftest() -> int:
    """内嵌夹具自证：admin/评审不用信我的话,跑 `--selftest` 就行。"""
    failures: list[str] = []

    def check(cond: bool, what: str) -> None:
        if not cond:
            failures.append(what)

    tmp = tempfile.mkdtemp(prefix="test-margin-selftest-")
    try:
        with open(os.path.join(tmp, "fixture.test.ts"), "w", encoding="utf-8") as fh:
            fh.write(SELFTEST_FIXTURE)
        index = index_source(tmp)

        # ⓪ 隐式默认**必须是解析出来的**，而且这个断言要能钉住常量本身 ——
        #    上一次自证里 evaluate() 收的是写死的 5_000，所以把常量改回 20_000
        #    自证照样过（#1309 评审第 ① 条就这么漏过去的）。这里改成解析真值。
        dflt = resolve_default_ms(tmp)          # tmp 里没有 bunfig.toml
        check(dflt == PINNED_BUN_DEFAULT_MS, f"无 bunfig.toml 时必须用实测默认（得到 {dflt}）")
        check(PINNED_BUN_DEFAULT_MS == 5_000,
              f"🔴 钉死的 bun 1.3.14 实测默认是 5000ms（得到 {PINNED_BUN_DEFAULT_MS}）"
              "—— 2026-10-15 用 `oven/bun:1.3.14` 实测：无声明测试 5000.01ms 超时，"
              "加不加 --coverage 都是 5000.01ms")
        with open(os.path.join(tmp, "bunfig.toml"), "w", encoding="utf-8") as fh:
            fh.write('[test]\ntimeout = 30_000\n')
        check(resolve_default_ms(tmp) == 30_000,
              "bunfig.toml 出现时必须以它为准（否则分母又变成猜的）")
        os.remove(os.path.join(tmp, "bunfig.toml"))

        # ① 声明超时的解析（分母从哪来）
        check(index.get("no declared timeout here", (None, ""))[0] is None,
              "「自己、describe 都没声明」必须解析成 None ⇒ 用实测默认")
        check(index.get("declared but tiny", (None, ""))[0] == 4_000,
              "自己声明的 4_000 必须被解析出来")
        check(index.get("short timeout", (None, ""))[0] == 500,
              "🔴 自己声明的 **500** 必须被解析出来（旧的 >=1000 守卫会把它丢掉）")
        # 🔴 **单行**形式 —— #1309 评审给的见证原文就是这一行。旧解析器只认
        #    行首是 `}` 的 closer，于是它拿到默认值，450ms/500ms 被算成 9%。
        check(index.get("one line declared", (None, ""))[0] == 500,
              "🔴 单行 `test(\"one line declared\", () => { … }, 500);` 必须解析出 500"
              "（评审见证原文的写法；只认行首 `}` 的解析器会把它算成 450/5000 = 9%）")
        # 柯里化 `test.skipIf(cond)("…", …, N)` —— 仓库里 runtime.test.ts:1065 就是这个
        # 形状（声明 30_000）；旧解析器不认第二层调用 ⇒ 那一条退默认。
        check(index.get("curried declared", (None, ""))[0] == 9_000,
              "柯里化 `test.skipIf(cond)(\"…\", …, 9_000)` 的声明必须解析出来")
        check(index.get("one line no declaration", (None, ""))[0] is None,
              "单行且无声明的测试必须解析成 None（⇒ 用默认），不能留下弹不掉的栈帧")
        check(index.get("declares twenty", (None, ""))[0] == 20_000,
              "自己声明的 20_000 必须被解析出来（显式 20s 覆盖必须保留）")
        check(index.get("safely fast", (None, ""))[0] is None,
              "🔴 前一 describe 的测试不得继承后一 describe 的 30_000（两趟遍历的核心）")
        check(index.get("inherits the describe timeout", (None, ""))[0] == 30_000,
              "describe 级 30_000 必须被它的测试继承（`}, N)` 在测试之后）")

        # ② 正控：7 条该被报出，且分母各不相同（含**单行**与**柯里化**两种声明）
        log = SELFTEST_LOG
        _b, hooks, _e, near = evaluate(parse_timings(log), index, 50.0, dflt)
        got = {n.split(" > ")[-1].strip(): (ms, eff, pct) for ms, eff, pct, _l, n in near}
        want = {
            "no declared timeout here": (19_000.0, 5_000, 380.0),
            "declared but tiny": (3_800.0, 4_000, 95.0),
            "short timeout": (450.0, 500, 90.0),
            "one line declared": (450.0, 500, 90.0),
            "curried declared": (8_000.0, 9_000, 88.889),
            "inherits the describe timeout": (21_000.0, 30_000, 70.0),
            "(unnamed hook — beforeEach/afterEach)": (4_900.0, 5_000, 98.0),
        }
        check(set(got) == set(want), f"贴上限集合：得到 {sorted(got)}，期望 {sorted(want)}")
        for k, exp in want.items():
            got1 = got.get(k)
            check(got1 is not None and got1[0] == exp[0] and got1[1] == exp[1]
                  and abs(got1[2] - exp[2]) < 0.051, f"{k}：得到 {got1}，期望 {exp}")
        check(hooks == 1, f"钩子必须被计数（得到 {hooks}）")
        pcts = [p for _m, _e, p, _l, _n in near]
        check(pcts == sorted(pcts, reverse=True), "贴上限条目必须按占比降序")

        # ③ 显式 20s 覆盖必须**真的**被用上：4000/20000 = 20% ⇒ 不报
        check("declares twenty" not in got,
              f"🔴 自己声明了 20_000 的测试（实测 4000ms = 20%）不许进贴上限集合，得到 {sorted(got)}")
        # ③b 单行无声明那条：1000/5000 = 20% ⇒ 不报（同时证明它没有把栈带坏）
        check("one line no declaration" not in got,
              f"单行无声明（实测 1000ms = 20%）不该进贴上限集合，得到 {sorted(got)}")

        # ④ 钩子超时：分母必须是**它撞上的**那个超时，不是测试自己的 5000
        hook_log = SELFTEST_HOOK_LOG
        hf = parse_hook_failures(hook_log)
        check(hf == {"hook control > body passes"}, f"钩子失败必须被识别（得到 {hf}）")
        hit = [e for e in evaluate(parse_timings(hook_log), index, 50.0, dflt, hf)[2]
               if e[4] == "hook control > body passes"]
        # 分母 = 记录行里那个 ms（30000.02ms —— 钩子声明的 30s 被**用满**），
        # 不是测试自己的 5000，也不是源码里那串 30_000（日志里根本没有它）。
        check(len(hit) == 1 and abs(hit[0][1] - 30_000.02) < 0.001 and abs(hit[0][2] - 100.0) < 0.001,
              f"🔴 30s 钩子超时必须报 100%（分母 = 它撞上的 30000.02ms），得到 {hit}")
        mis = evaluate(parse_timings(hook_log), index, 50.0, dflt)[2]
        check(any(abs(e[2] - 600.0) < 0.5 for e in mis),
              "反向见证：不做钩子识别时这条会被按 5000ms 报成 600%（#1309 评审，必须仍然可复现）")

        # ⑤ 负控：都不贴上限 ⇒ 一条都不许报
        quiet = ("(pass) margin control > safely fast [100.00ms]\n"
                 "(pass) margin control > declares twenty [4000.00ms]\n"
                 "(pass) (unnamed) [100.00ms]\n")
        if evaluate(parse_timings(quiet), index, 50.0, dflt)[3] != []:
            failures.append("全都很快时必须一条都不报")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("TEST-MARGIN SELFTEST FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("TEST-MARGIN SELFTEST OK (3 default-resolution + 9 declared-resolution "
          "(incl. one-line + curried) + 7 positive + 1 hook-count + 1 order "
          "+ 1 explicit-20s-not-reported + 1 one-line-not-reported + 1 hook-timeout "
          "+ 1 hook-misattribution-witness + 1 negative)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="per-test timeout margin report (#1627)")
    ap.add_argument("--logs", nargs="+",
                    help="日志文件或 glob（默认当作 glob 展开，不存在则跳过）")
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    help="仓库根（用来解析声明超时）")
    ap.add_argument("--pct", type=float, default=float(os.environ.get("TEST_MARGIN_PCT", DEFAULT_PCT)),
                    help="贴上限阈值（占有效超时的百分比），默认 50")
    ap.add_argument("--default-ms", type=int, default=None,
                    help="隐式默认超时（ms）；缺省时 = 环境变量 TEST_MARGIN_DEFAULT_MS "
                         "> bunfig.toml 的 [test] timeout > 实测的钉死 bun 值")
    ap.add_argument("--fail", action="store_true", help="有贴上限条目时退出 1（默认只报告）")
    ap.add_argument("--selftest", action="store_true",
                    help="用内嵌夹具自证（解析/正控/负控），不读任何日志")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.logs:
        ap.error("--logs 必填（除非用 --selftest）")

    default_ms = args.default_ms if args.default_ms is not None else resolve_default_ms(args.root)

    files: list[str] = []
    for pat in args.logs:
        hits = sorted(globlib.glob(pat))
        if not hits and os.path.isfile(pat):
            hits = [pat]
        files.extend(h for h in hits if os.path.isfile(h))

    rows: list[tuple[str, str, float]] = []
    hook_failures: set[str] = set()
    for f in files:
        try:
            text = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        rows.extend(parse_timings(text))
        hook_failures |= parse_hook_failures(text)

    if not files:
        print(f"TEST-MARGIN v1 tests=0 hooks=0 threshold={args.pct:g}% near=0 slowest=-"
              f"  # 没有可读日志（--logs 给的是 {args.logs}）")
        return 0

    # 同名去重、分母解析、贴上限排序全在 evaluate() 里 —— selftest 走同一条路径，
    # 所以自证通过就意味着真实调用路径正确，而不是「另一份逻辑副本对上了」。
    best, hooks, entries, near = evaluate(rows, index_source(args.root), args.pct,
                                          default_ms, hook_failures)

    # 🔴 `slowest=` 里的百分比必须和 `near=` 用同一个分母（有效超时），
    #    不能打毫秒却标 `%` —— 第一版就是这样，输出 `waitWs_...=18069.0%`，
    #    看起来像一个「超高危」，其实是 30.1%。
    slowest = ", ".join(f"{slug(n)}={p:.1f}%" for _ms, _eff, p, _loc, n in
                        sorted(entries, key=lambda e: -e[0])[:3])
    print(f"TEST-MARGIN v1 tests={len(best)} hooks={hooks} threshold={args.pct:g}% "
          f"near={len(near)} slowest={slowest or '-'}")
    for ms, eff, pct, loc, name in near:
        print(f"  NEAR-LIMIT {ms:.0f}ms / {eff}ms = {pct:.1f}%  {loc}  :: {name}")
    if near:
        print(f"  ⇒ 有效超时是「自己声明的，否则所在 describe 的，否则运行器默认 "
              f"{default_ms}ms（本仓库钉死的 bun 1.3.14 实测值；bunfig.toml 的 "
              f"[test] timeout 或 TEST_MARGIN_DEFAULT_MS 会覆盖）」；"
              "慢 runner 上这些会先红，而报错会像是真缺陷（#1627）。")
    return 1 if (near and args.fail) else 0


if __name__ == "__main__":
    sys.exit(main())
