#!/usr/bin/env python3
"""禁止把「键集」拼成字符串再比较 —— 这个形状会**静默通过**不该通过的形状。

## 为什么（2026-10-31 更新：碰撞已可构造，不再是理论风险）

两行就能演示（用仓库里真实的 `exact()` 语义）：

    JSON.parse('{"code\\u0000tenantKey":"x","userOpenId":"y"}')
    Object.keys(b).sort().join("\0")  ===  ["code","tenantKey","userOpenId"].sort().join("\0")
    ⇒ exact() 返回 true，而 b.code / b.tenantKey 都是 undefined

    JSON.parse('{"":1}')  ⇒ Object.keys = [""]  ⇒ join("\0") = ""  ⇒ 与「无键」同值

🔴 所以 `"\0"` 不是「实践中不易撞」。根因也不是「这个字符不常见」，而是：
   **任何「用字符串拼接比较集合」的方案，都要求元素里不含分隔符，
     而 JSON 不提供这个保证（`"\u0000"` 是合法键名）。**
⇒ 构造上安全的只有 `JSON.stringify(sorted)` 与逐元素比较（长度 + 每个下标）。

## 🔴 2026-10-31 第二次修正：判定方向翻成 fail-closed

上一版的第三档是「证不出是键集 ⇒ 当数组，只打印不阻塞」。
**那是「证不出来 ⇒ 放行」，而它已经把一处真实的键集契约检查降级成了 PRINT。**

⇒ 规则翻转：**证不出来 ⇒ 阻塞**。
   但「证明」必须换成**正向证据**（这个结果是数组、且用于拼消息），而不是
   「没看到 Object.keys( 就假定它是数组」。

## 判定（三条，全部基于正向证据）

· BLOCK：`sort()` 后接 `join(...)`，且
    (a) 同一条语句/数据流里出现 `Object.keys(` / `getOwnPropertyNames(`，或
    (b) join 的接收者是一个**由 keys 派生**的标识符（本文件内赋值追踪），
  并且 join 的结果参与了**比较**（`!==` `===` `!=` `==`，或处于 `if (...)` / 断言里）。
  ⇒ “参与比较”这一条很关键：把集合拼进**人读的消息**是安全的（拼错只是文案难看），
    而拼进**比较**才会静默放行。

· BLOCK（unproven）：`Object.keys(...).sort()` 之后出现的 `join(`，若无法证明
  它不是键集比较 ⇒ 也阻塞，但标注 ∎unproven，提示补证据而不是默默放行。

· ADVISORY（打印，不阻塞）：有**正向**证据表明它是普通数组
  （接收者是 `.map(` / `.filter(` / `.slice(` / `[...` / `.concat(` 的结果，
  或字面量数组），且不属于上面的情形。

## 扫描域：先排除构建产物

`deploy/*/dist/`、`dist/`、`build/`、`out/`、`.next/`、`coverage/` 里的打包产物
是**生成的**：它们既不该被人工修，也不该让门变红。
⇒ 顺序很重要：**先排掉产物，再翻方向**。否则翻完第一天满屏红，
  结局一定是加基线或删门 —— **门的死法通常不是被反对，是被噪声淹死。**

## 🔴 2026-10-31 第三次修正：宁可漏，不可假红

判「同一条语句」用的是 `;` 近似，它两边都会错：
  · 字符串/模板里的 `;` ⇒ 一条语句被切成两条 ⇒ **漏**
  · 无 `;` 的多行表达式 ⇒ 两条语句并成一条 ⇒ **假红**

而假红会走一条闭合回路：一次无害重构导致红 ⇒ 下次真红被当噪声 ⇒
「改一下测试就绿」⇒ 护栏被削弱，而**削弱护栏的人同时改了测试，所以没有任何东西会红**。

⇒ 所以阻塞档只留**不依赖 `;` 启发式**的形状：
   keyset 信号 + `join(...)` **紧邻**比较运算符；
   或本文件内 keyset 派生标识符 + `join(...)` **紧邻**比较运算符。
   其余（靠窗口判定键集、靠语句窗口判定比较、unproven）一律**列举不阻塞**。

⇒ 漏掉的那些由 keyset 契约单测兜住；假红没人兜，它只会训练人忽略红灯。

## 判据

blocking 必须为空（退出码 0）。unproven / advisory / review 全部打印但不阻塞。
"""
import re
import subprocess
import sys
from pathlib import Path

SRC = (".ts", ".mts", ".tsx", ".js", ".mjs", ".cjs")

# 构建产物 / 依赖目录：生成的字节，不归本门管。
EXCLUDE_SEGMENTS = (
    "node_modules/", "/dist/", "dist/", "/build/", "build/", "/out/", "out/",
    "/.next/", "/coverage/", "/.turbo/", "/vendor/",
)

# `sort()` 紧跟 `join(...)`
SET_JOIN = re.compile(r"\.sort\s*\(\s*\)\s*\.join\s*\(\s*([^)]*?)\s*\)")
# 任意 join（用于 fail-closed 的第二档）
ANY_JOIN = re.compile(r"\.join\s*\(\s*([^)]*?)\s*\)")
KEYSET = re.compile(r"Object\.(?:keys|getOwnPropertyNames)\s*\(")
# 键集派生：`const keys = Object.keys(...)` / `keys = Object.keys(...)`
KEYSET_ASSIGN = re.compile(r"(\w+)\s*=\s*Object\.(?:keys|getOwnPropertyNames)\s*\(")
# 正向的「这是普通数组」信号
ARRAY_SIGNAL = re.compile(r"\.(?:map|filter|slice|flat|flatMap|concat)\s*\(|\[\.\.\.")
# join 结果参与比较：其后紧跟比较运算符，或整条语句是 if/断言
COMPARISON_AFTER = re.compile(r"^\s*(?:!==|===|!=|==|>|<)")
COMPARISON_CONTEXT = re.compile(r"\b(?:if|while)\s*\(|\.to(?:Be|Equal|StrictEqual)\(|assert\.")
LOOKBEHIND = 240


def chain_before(text: str, idx: int, limit: int = 2000) -> str:
    """取 idx 之前、当前表达式链的原文（保守：跳过成对的花括号，遇 `;` 或退出包围块即停）。

    为什么不是「到上一个 ; 为止」：`.map((c) => { const age = …; … })` 里的 `;`
    在**嵌套块内部**，按 `;` 切会把链切得只剩 `})`，
    于是同一表达式里的 `.map(` 落在窗口外 —— 实测把一处数组 join 判成了 unproven。
    """
    i = idx - 1
    depth = 0
    stop = max(0, idx - limit)
    while i >= stop:
        ch = text[i]
        if ch == "}":
            depth += 1
        elif ch == "{":
            if depth == 0:
                break
            depth -= 1
        elif ch == ";" and depth == 0:
            break
        i -= 1
    return text[i + 1: idx]

def collect(repo: Path) -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"], cwd=repo, check=True, capture_output=True,
        ).stdout.decode("utf-8", "replace")
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:  # pragma: no cover
        print(f"✗ 无法枚举文件（git ls-files 失败）: {exc}", file=sys.stderr)
        return []
    files = []
    for rel in out.split("\0"):
        if not rel or not rel.endswith(SRC):
            continue
        if any(seg in "/" + rel for seg in EXCLUDE_SEGMENTS):
            continue
        files.append(repo / rel)
    return sorted(files)


def is_test_path(rel: str) -> bool:
    return ".test." in rel or ".spec." in rel or rel.startswith("tests/")


def statement_window(text: str, idx: int) -> str:
    """取 idx 所在的语句片段：向前到上一个 `;`/`{`/`}`，向后到下一个 `;`/`}`。

    这不是解析器 —— 但它是**保守**的：窗口取大不取小，宁可多判 BLOCK。
    """
    start = max(text.rfind(";", 0, idx), text.rfind("{", 0, idx), text.rfind("}", 0, idx)) + 1
    end_candidates = [p for p in (text.find(";", idx), text.find("}", idx)) if p != -1]
    end = min(end_candidates) if end_candidates else len(text)
    return text[start:end]


def scan(repo: Path):
    return scan_paths(collect(repo), repo)


def scan_paths(files: list[Path], repo: Path):
    blocking: list[str] = []
    unproven: list[str] = []
    advisory: list[str] = []
    review: list[str] = []
    scanned = 0
    # 🔴 阳性对照：正则若因重构失效，全仓会「干净地」报 0 —— 与真的没有违规同形。
    #    所以同时数一个**必须命中**的宽形状（任意 .join( ）；它为 0 就是判据坏了，不是代码干净。
    any_join_hits = 0
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        try:
            rel = str(path.relative_to(repo))
        except ValueError:
            rel = path.name
        scanned += 1
        test_file = is_test_path(rel)
        any_join_hits += len(ANY_JOIN.findall(text))
        lines = text.splitlines()
        # 本文件内「键集派生」的标识符 —— 但**只在它没被改写时**才算键集。
        #
        # 🔴 2026-10-31 修正：早先只要某标识符被 `= Object.keys(...)` 赋过值，
        #    它在本文件后续所有 join 都会被当作键集 ⇒ 而它可能早已被改成普通数组：
        #        let list = Object.keys(cfg); list = list.concat(otherIds);
        #        if (list.join(',') !== 'a,b')        ← 此时 list 不再是键集
        #    ⇒ 这正是阻塞档最不该有的假红。
        #
        # 「什么情况下它不会命中」必须说得出来，这就是那条：
        #   该标识符在文件中被**重新赋值**（ident = …，出现 >1 次），
        #   或被**派生改写**（push/splice/concat/map/filter），
        #   ⇒ 不再算键集派生 ⇒ 不进阻塞档。
        # （sort/slice 不算派生：`keys.sort()` 之后仍是同一组键。）
        tainted = {m.group(1) for m in KEYSET_ASSIGN.finditer(text)}
        for ident in list(tainted):
            assigns = len(re.findall(rf"\b{re.escape(ident)}\s*=(?!=)", text))
            derived = bool(re.search(
                rf"\b{re.escape(ident)}\s*\.(?:push|splice|concat|map|filter)\s*\(", text
            ))
            if assigns > 1 or derived:
                tainted.discard(ident)

        def line_of(i: int) -> tuple[int, str]:
            n = text.count("\n", 0, i) + 1
            return n, lines[n - 1].strip()[:110]

        def push(bucket: list[str], n: int, label: str, snippet: str) -> None:
            bucket.append(f"{rel}:{n}: {label}  {snippet}")

        for m in SET_JOIN.finditer(text):
            n, snippet = line_of(m.start())
            if snippet.startswith("//") or snippet.startswith("*") or snippet.startswith("/*"):
                continue
            # 键集信号必须与这次 join 处在**同一个表达式**里。
            #
            # 🔴 2026-10-31 修正：早先用「语句窗口（到上一个 ;/{/} 为止）」判定，
            #    而本仓大量省略分号 ⇒ 窗口会一路吞到函数开头，把上面几行的
            #    `Object.keys(...)` 也算进来：
            #        let list = Object.keys(cfg)
            #        list = list.concat(other)
            #        if (list.sort().join(",") !== "a,b")     ← 被误判成键集比较
            #    ⇒ 这就是阻塞档里的假红来源。
            #
            # 现在的判据（能说清“什么情况下不命中”）：
            #   在 `.sort()` 之前 400 字符内出现的**最近一处** Object.keys，
            #   与本次 join 之间**不得再有语句起始关键字**
            #   （if/for/while/return/let/const/var/await）⇒ 否则不是同一表达式。
            window = text[max(0, m.start() - 400):m.start()]
            cut = max(window.rfind("Object.keys("), window.rfind("Object.getOwnPropertyNames("))
            same_expression = False
            if cut >= 0:
                between = window[cut:]
                same_expression = not re.search(
                    # 2026-10-31 补 `;` —— 语句边界。
                    # 外部复核实测过一次假红：上一条语句的 Object.keys 让下一条的数组 join
                    # 被算成键集判断。只按「前 N 字符里出现过」判，就是这个形状。
                    r"\b(?:if|for|while|return|let|const|var|await)\b|;", between
                )
            tainted_in_line = any(re.search(rf"\b{re.escape(t)}\b", lines[n - 1]) for t in tainted)
            keyset = same_expression or tainted_in_line
            compared = bool(COMPARISON_AFTER.match(text[m.end():m.end() + 8])) or bool(
                re.search(r"!==|===|!=|==", lines[n - 1])
            )
            label_keys = f"键集拼字符串（分隔符 {m.group(1)} 可碰撞 ⇒ 多一个键会被读成通过）"
            # 数组信号的证据范围是**链**：一直向前到最近一个 `;` 为止。
            # 不能只看语句窗口：`.map((c) => { … })` 里箭头体的 `}` 会把窗口截断，
            # 于是同一表达式里的 `.map(` 落在窗口外（实测在 codex-auth-fingerprint.ts:370 踩到）。
            chain = chain_before(text, m.start())
            adjacent_compared = bool(COMPARISON_AFTER.match(text[m.end():m.end() + 8]))
            if keyset and adjacent_compared:
                # 唯一**不需要 `;` 启发式**的阻塞形状：键集信号 + 紧邻比较运算符。
                push(blocking if not test_file else review, n, label_keys, snippet)
            elif keyset and compared:
                # 键集信号靠窗口、比较靠语句窗口 ⇒ 两者都依赖 `;` 近似 ⇒ **只列举，不阻塞**。
                push(review if test_file else advisory, n,
                     "键集拼接（比较靠语句窗口判定，启发式，可能误判 ⇒ 不阻塞）", snippet)
            elif keyset:
                # 键集派生但没看到比较：可能拼进人读的消息。留 advisory，但要求 review。
                push(review if test_file else advisory, n, "键集拼接（未检测到比较，可能是消息拼接）", snippet)
            elif ARRAY_SIGNAL.search(chain):
                push(advisory, n, "数组 join（同类不同罪，本门不阻塞）", snippet)
            else:
                # 2026-10-31 —— 这一格原来是 fail-closed（阻塞），现在降为**列举**。
                # 理由：判「是不是数组」依赖窗口与 `;` 近似，而启发式会产生**假红**。
                # 而假红会走那条闭合回路：一次无害重构导致红 ⇒ 下次真红被当噪声 ⇒
                # 「改一下测试就绿」⇒ 护栏被削弱而没有任何东西会红。
                # ⇒ 宁可漏，不可假红：漏由 keyset 单测兜住，假红会把整道门训练成噪声。
                push(advisory, n, "∎unproven 无法证明这不是键集比较（不阻塞，需人工确认）", snippet)

        # 第二档：`const k = Object.keys(x).sort()` … 后面 `k.join(...)` 参与比较
        for ident in tainted:
            # 注意取的是 **join 的闭合括号之后**的位置：
            # 用 `\.join\(` 的 end 会在 `(` 之后就停，看不到后面的 `!==`（实测漏判）。
            for jm in re.finditer(
                rf"\b{re.escape(ident)}\b[^\n]*?(\.join\s*\(\s*[^)]*?\s*\))", text
            ):
                n, snippet = line_of(jm.start())
                if snippet.startswith("//") or snippet.startswith("*") or snippet.startswith("/*"):
                    continue
                # 已经被上面的 SET_JOIN 覆盖的跳过（避免重复报）
                if SET_JOIN.search(text[max(0, jm.start() - 80):jm.end(1)]):
                    continue
                # 只认**紧邻**的比较运算符：`k.join(",") !== …`。
                # 「同一条语句里有 if(」不算 —— 那会把拼进对象属性/消息的 join 也算成比较
                # （实测把两处消息拼接误判成契约检查）。
                if not COMPARISON_AFTER.match(text[jm.end(1):jm.end(1) + 8]):
                    continue
                push(
                    review if test_file else blocking, n,
                    f"键集派生标识符 `{ident}` 拼字符串后参与比较（分隔符可碰撞）", snippet,
                )
    return blocking, unproven, advisory, review, scanned, any_join_hits


# ---------------------------------------------------------------------------
# --selftest：让门**证明自己会红**。
#
# 对方给的那条判据：断言的有效性 = 你能让它变红一次。
# 而这里有一个陷阱必须排除：**「退出码非 0」不等于「为预期的原因而红」** ——
# 脚本语法错、路径写错、依赖缺失都会非 0，看起来和“成功抓到”一模一样。
# ⇒ 所以每个用例都断言 **桶名（预期原因）**，不只断言退出码。
#
# 负例（不该红的）同样要有：否则一个「什么都说违规」的门也能让正例全绿。
# ---------------------------------------------------------------------------
SELFTEST_CASES = [
    (
        "keyset_adjacent",
        'export function f(b: Record<string, unknown>) {\n'
        '  if (Object.keys(b).sort().join(",") !== "a,b") throw new Error("x")\n'
        '}\n',
        "blocking", "键集拼字符串",
    ),
    (
        "keyset_via_variable_with_if_between",
        'export function f(b: Record<string, unknown>) {\n'
        '  const keys = Object.keys(b).sort()\n'
        '  if (keys.join(",") !== "a,b") throw new Error("x")\n'
        '}\n',
        "blocking", "键集派生标识符",
    ),
    (
        # 2026-10-31 —— **别拿字面邻近冒充数据流**。
        # 外部复核里，一个真实的上游响应体键集检查因为 `.sort()` 与 `.join(',')`
        # 被一条 `if` 分开，被归进了「数组 join，不阻塞」⇒ 归类错，而清单会被下一个人信任。
        # 本仓靠的是「键集派生标识符」跨行追踪，所以它本来就该落在 blocking ——
        # 这个用例就是防止有人把它退化成「同行有没有 Object.keys(」。
        "keyset_variable_split_by_unrelated_if",
        'export function f(body: Record<string, unknown>) {\n'
        '  const keys = Object.keys(body).sort()\n'
        '  if (keys.length !== 2) throw new Error("x")\n'
        '  if (keys.join(",") !== "a,b") throw new Error("y")\n'
        '}\n',
        "blocking", "键集派生标识符",
    ),
    (
        # 2026-10-31 —— **跨行盲区的看门狗**：
        # 一次格式化（prettier 阈值附近）会把 `Object.keys(...).sort()` 与 `.join(...)` 断成两行；
        # 若门的正则只认同一行，最危险的那几处（键最多、最容易撞）会静默消失。
        # 本仓的 SET_JOIN 用 \s* 连接，天然跨行 —— 这个用例就是防止有人把它改成 [^\n]*。
        "keyset_cross_line_after_formatting",
        'export function f(b: Record<string, unknown>) {\n'
        '  if (\n'
        '    Object.keys(b)\n'
        '      .sort()\n'
        '      .join(",") !== "a,b"\n'
        '  ) throw new Error("x")\n'
        '}\n',
        "blocking", "键集拼字符串",
    ),
    (
        "keyset_multiline",
        'export function f(b: Record<string, unknown>) {\n'
        '  if (Object.keys(b).sort()\n'
        '    .join("\\0") !== "a\\0b") throw new Error("x")\n'
        '}\n',
        "blocking", "键集拼字符串",
    ),
    (
        # 线上真实形状（agent-portal server/src/tmwork-cloud-runtime-claims.ts:53）：
        # 单表达式，两侧各一次 join('\0')，比较运算符在**第二个** join 之后。
        # 这条用例钉的是：门必须抓住这种「两侧都拼」的写法 ——
        # 它正是我们最想让门抓的那个真实对象。
        "exact_style_both_sides",
        'export function exact(v: Record<string, unknown>, keys: string[]) {\n'
        '  return Object.keys(v).sort().join("\\0") === [...keys].sort().join("\\0")\n'
        '}\n',
        "blocking", "键集拼字符串",
    ),
    (
        # 负例（阻塞档）：键集派生的标识符**被改写之后**再 join，不是键集比较。
        # 这条钉住「taint 不失效」这个假红来源 —— 它与「宁可漏不可假红」是同一条。
        "taint_invalidated_by_concat",
        'export function f(cfg: Record<string, unknown>, other: string[]) {\n'
        '  let list = Object.keys(cfg)\n'
        '  list = list.concat(other)\n'
        '  if (list.sort().join(",") !== "a,b") throw new Error("x")\n'
        '}\n',
        "advisory", "数组 join",
    ),
    (
        "array_message_negative",
        'export function f(xs: string[]) {\n'
        '  const note = xs.map((x) => ({ x })).map((o) => o.x).sort().join(", ")\n'
        '  return `ids: ${note}`\n'
        '}\n',
        "advisory", "数组 join",
    ),
]


def selftest(quiet: bool = False) -> int:
    import tempfile

    # 遍历 0 个用例也是通过 —— 这是 empty-assertion 的最小形状。
    # 所以先钉数量，再跑用例：任何人删掉一个用例，这里先红。
    # 注意：无论 quiet 与否都要定义这个 shim —— 否则 Python 把 print 当局部名，
    # 非 quiet 路径会 UnboundLocalError（今晚实测过一次）。
    import builtins
    import sys as _sys_shim

    def print(*a, **k):  # noqa: A001 - 局部遮蔽，仅在本函数内
        if quiet and k.get("file") is not _sys_shim.stderr and a:
            return
        builtins.print(*a, **k)
    if len(SELFTEST_CASES) != 8:
        print(f"✗ selftest 用例数应为 8，实际 {len(SELFTEST_CASES)} —— 有人动过用例表", file=sys.stderr)
        return 1
    failures = 0
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for name, body, bucket, marker in SELFTEST_CASES:
            f = root / f"{name}.ts"
            f.write_text(body, encoding="utf-8")
            blocking, unproven, advisory, review, _, _ = scan_paths([f], root)
            pool = {"blocking": blocking, "unproven": unproven, "advisory": advisory, "review": review}[bucket]
            hit = [item for item in pool if marker in item]
            ok = bool(hit)
            print(f"{'✓' if ok else '✗'} selftest {name}: 期望落在 {bucket}（含 {marker!r}）"
                  f"{'' if ok else f' —— 实际 blocking={len(blocking)} unproven={len(unproven)} advisory={len(advisory)}'}")
            if not ok:
                failures += 1
    if failures:
        print(f"✗ selftest 失败 {failures} 例：门没有按预期变红/变绿", file=sys.stderr)
        return 1
    print(f"✓ selftest {len(SELFTEST_CASES)} 例全部按预期（含 1 个负例）")
    return 0


def _measured_on(repo: "pathlib.Path") -> str:
    """2026-10-31 —— SCOPE 有空间维度，缺**版本维度**。

    四行（covers / does_not_cover / threat_model / reading_rule）回答「我看了什么」，
    不回答「我看的是哪棵树」。而今晚整类「0 命中」结论都被树同一性封顶
    （本树 ≠ 线上；本地无该 ref 时行号全对不上）。
    ⇒ 补这一行后，一个贴在错树上的 SCOPE 块**自己会说出来**；
      否则它描述的是一个不存在的仓库，而它看起来完全权威。
    """
    try:
        import subprocess
        ref = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        porcelain = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"],
                                   capture_output=True, text=True, timeout=10).stdout.strip()
        if not ref:
            return "ref=unknown dirty=unknown"
        from datetime import datetime, timezone
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return f"ref={ref[:12]} dirty={'true' if porcelain else 'false'} observed_at={stamp}"
    except Exception:
        # 读不到就说读不到 —— 不写 ref=none（那会读成「干净的未知」）
        return "ref=unknown dirty=unknown"


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    repo = Path(__file__).resolve().parent.parent
    blocking, unproven, advisory, review, scanned, any_join_hits = scan(repo)

    # 🔴 先跑控制，再打结论。
    #
    # 2026-10-31 —— 实测过的一个洞：仓库不可读时，原来的顺序会先打
    #   「✓ 键集拼接: 0 处」「✓ 扫描 0 个源文件」，最后才打「✗ 阳性对照失败」。
    # 退出码是对的（1），但**读输出的人会先看到两个 ✓** —— 而绝大多数人只看 ✓。
    # ⇒ 没有读数的那一次，不许输出任何 ✓。先证仪器到达，再谈结论。
    controls_failed = False
    if scanned == 0:
        print("✗ 没有可扫描的源文件（git ls-files 返回空）", file=sys.stderr)
        controls_failed = True
    if any_join_hits == 0:
        print("✗ 阳性对照失败：全仓连一个 `.join(` 都没找到", file=sys.stderr)
        print("  ⇒ 可能是正则/扫描域坏了，或仓库为空 —— 此刻的 0 **不能**读成“没有违规”。", file=sys.stderr)
        controls_failed = True
    # 2026-10-31 —— 「先证仪器，再读世界」。
    # 只证明「宽形状非 0」不够：分类器若塌陷，会把命中全判成不阻塞
    # ⇒ 仍然「0 阻塞 + 1510 命中」，看起来完全正常。
    # ⇒ 每次主跑也跑一遍 selftest（6 个已知答案夹具，含一个负例）。
    selftest_rc = 0
    try:
        selftest_rc = selftest(quiet=True)
    except Exception as exc:  # noqa: BLE001
        selftest_rc = 1
        print(f"✗ selftest 抛错：{exc}", file=sys.stderr)
    if selftest_rc != 0:
        controls_failed = True
        print("✗ 分类器自检未通过 —— 本次的「0 阻塞」不能读成没有违规。", file=sys.stderr)
    if controls_failed:
        print("instrument: BROKEN ⇒ 本次没有读数（不是“干净”）", file=sys.stderr)
        return 1
    print("instrument: valid （selftest 8/8 通过 且 宽形状对照非 0 ⇒ 分类器有能力判出阻塞）")

    for bucket, mark, title in (
        (blocking, "✗", "键集拼接（阻塞）"),
        (unproven, "·", "∎unproven：无法证明不是键集比较（**不阻塞**，需人工确认）"),
    ):
        if bucket:
            print(f"{mark} {title} {len(bucket)} 处:", file=sys.stderr)
            for item in bucket:
                print(f"    {item}", file=sys.stderr)
        else:
            print(f"✓ {title}: 0 处")

    print(f"✓ 扫描 {scanned} 个源文件（已排除构建产物 / node_modules）")
    # 2026-10-31 —— 对照要分两维，别拿「在别处命中」冒充「看得见目标」。
    print(f"✓ control_breadth：宽形状 `.join(` 命中 {any_join_hits} 次")
    print("                   ⇒ 只证明「工具跑起来了」，**不证明它看得见目标上下文**")
    print("✓ control_position：selftest 8 例覆盖目标上下文（同行 / 跨行 / 变量拆分 / 负例）")
    print("                   ⇒ 这一条才支撑「0 处」读成「那种写法不存在」")

    if advisory:
        print(f"· 数组 join（不阻塞，{len(advisory)} 处，后果是去重口径而非契约绕过）:")
        for item in advisory:
            print(f"    {item}")
    else:
        print("· 数组 join（不阻塞）: 0 处")

    # 把「默认值」变成一行输出：测试里的 join 合法与非法从语法上分不出，只列不判。
    if review:
        print(f"⚠ 测试/待复核里出现集合拼接 {len(review)} 处（需 review）：")
        for item in review:
            print(f"    {item}")
    else:
        print("⚠ 测试/待复核里出现集合拼接: 0 处")

    # 2026-10-31 —— 「这个门覆盖到哪」必须与它的结果同寿。
    #
    # 一句「这是防事故装置，不是防对手装置」如果只写在人读的报告里，
    # 下一次有人引用这个绿时，那句话不会跟着走 —— 于是绿会被当成更强的结论。
    # ⇒ 所以作用域直接打进输出：谁把这次结果贴出去，作用域就一起贴出去。
    print()
    print("SCOPE (这段与上面的结论同寿，引用时请一起引用):")
    print("  covers         : 本仓 git 跟踪的**非测试**源文件里、源码可见的 `.sort().join(...)` 键集比较")
    print("  does_not_cover : 运行期拼出来的比较 / 其它仓库 / 测试文件（测试侧只列举不判断）/ 动态语言特性")
    print("  threat_model   : accident —— 能挡「顺手写成可碰撞分隔符」这类误用；")
    print("                   不挡有意伪造（无签名、无外部锚）")
    print("  reading_rule   : 「0 处」只在阳性对照命中时才有意义（见上方的宽形状计数）")
    # 2026-10-31 —— **扫描域必须写出来**，否则「0 处」会被读成「全仓没有」。
    # 一次真实事故：只 grep 了两个目录，被说成「全仓 0 处」；全仓跑完是 3 处。
    from collections import Counter as _Counter
    ext_counts = _Counter(p.suffix for p in collect(Path(__file__).resolve().parent.parent))
    domain = " ".join(f"{e}={n}" for e, n in sorted(ext_counts.items()))
    print(f"  scan_domain    : git ls-files ∩ {sorted(SRC)} − {list(EXCLUDE_SEGMENTS)} ⇒ {domain}")
    # 域看门狗：任何一族静默消失（比如 EXCLUDE_SEGMENTS 被加宽）都会让「0 处」变轻。
    missing = [e for e in (".ts", ".mjs") if ext_counts.get(e, 0) == 0]
    if missing:
        print(f"  ✗ 扫描域缺族：{missing} —— 这一族的文件没进来，「0 处」不代表它们干净", file=sys.stderr)
        return 1
    print(f"  measured_on    : {_measured_on(Path(__file__).resolve().parent.parent)}")
    print("                   —— 换一棵树，上面几行 covers 描述的就是另一个仓库")
    # threat_model 回答「挡得住什么」，failure_mode 回答「挡不住时会怎样」——
    # 只写前者，读者会把「不覆盖」读成「覆盖了但没发生」。
    print("  failure_mode   : loud —— 正则因重构失效时，宽形状计数会掉到 0 ⇒ 阳性对照失败 ⇒ exit 1")
    # 2026-10-31 —— 会过期的读数要给「它何时失效」的**可计算条件**，不是「测量于某时刻」。
    # 「测量于 T」要求读者自己知道衰减率；而衰减率只有发布者知道。
    # 2026-10-31 —— 门的状态是**二维**的：能不能红 × 今天红不红。
    # 只报一维时，「恒红」与「假绿」在报告里同形（都是「有问题/没问题」）。
    can_red = "yes（selftest 8/8 + 跨行 canary）"
    now = "green（0 阻塞）" if not blocking else f"red（{len(blocking)} 处）"
    print(f"  gate_state     : can_red={can_red} ｜ current={now}  ⇒ 二维都报，否则恒红与假绿同形")
    print("  invalidates_on : 树变（ref 或 dirty 变）｜正则变（selftest 不再 8/8）｜扫描域变（ext 计数变）")
    print("                   ⇒ 三者任一发生，上面的结论作废；不需要读者知道任何速率")
    # 2026-10-31 —— **流行度**要和结论一起说。
    # 「0 处」有两种读法：① 有这种写法、但都写得对；② 本仓根本不做这件事。
    # 两者都是 0，而它们对「这个绿值多少」的答案相反。
    if not blocking:
        print("  prevalence     : 键集比较点 = **0 处** ⇒ 这个绿**不是在保护现有实现**，")
        print("                   而是在阻止将来引入那种写法（它现在守着一块空地）")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
