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
        # 本文件内「键集派生」的标识符（弱数据流：同一文件的赋值即视为派生）
        tainted = {m.group(1) for m in KEYSET_ASSIGN.finditer(text)}

        def line_of(i: int) -> tuple[int, str]:
            n = text.count("\n", 0, i) + 1
            return n, lines[n - 1].strip()[:110]

        def push(bucket: list[str], n: int, label: str, snippet: str) -> None:
            bucket.append(f"{rel}:{n}: {label}  {snippet}")

        for m in SET_JOIN.finditer(text):
            n, snippet = line_of(m.start())
            if snippet.startswith("//") or snippet.startswith("*") or snippet.startswith("/*"):
                continue
            stmt = statement_window(text, m.start())
            keyset = bool(KEYSET.search(stmt)) or any(
                re.search(rf"\b{re.escape(t)}\b", stmt) for t in tainted
            )
            compared = bool(COMPARISON_AFTER.match(text[m.end():m.end() + 8])) or bool(
                re.search(r"!==|===|!=|==", stmt)
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
        "keyset_multiline",
        'export function f(b: Record<string, unknown>) {\n'
        '  if (Object.keys(b).sort()\n'
        '    .join("\\0") !== "a\\0b") throw new Error("x")\n'
        '}\n',
        "blocking", "键集拼字符串",
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


def selftest() -> int:
    import tempfile

    # 遍历 0 个用例也是通过 —— 这是 empty-assertion 的最小形状。
    # 所以先钉数量，再跑用例：任何人删掉一个用例，这里先红。
    if len(SELFTEST_CASES) != 4:
        print(f"✗ selftest 用例数应为 4，实际 {len(SELFTEST_CASES)} —— 有人动过用例表", file=sys.stderr)
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


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    repo = Path(__file__).resolve().parent.parent
    blocking, unproven, advisory, review, scanned, any_join_hits = scan(repo)

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
    # 阳性对照：宽形状必须命中。0 说明判据本身失效（或扫描域为空），不是“代码干净”。
    if any_join_hits == 0:
        print("✗ 阳性对照失败：全仓连一个 `.join(` 都没找到", file=sys.stderr)
        print("  ⇒ 要么正则/扫描域坏了，要么仓库是空的。此刻的 0 不能读成“没有违规”。", file=sys.stderr)
        return 1
    print(f"✓ 阳性对照：宽形状 `.join(` 命中 {any_join_hits} 次 ⇒ 判据确实到达了代码")

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

    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
