#!/usr/bin/env python3
"""tests/*/run.sh 里的 `sed -i 's/PAT/…/' <file>` —— PAT 必须仍能在目标文件里命中。

为什么需要这道门(2026-08-31 真实翻车):
  test649 的 L5 变异钉着 `(t.created_at || "?").padEnd(24)`。有人(我)把那一行重构成
  `padDisplayEnd(String(t.created_at || "?"), tW.created)` —— sed 匹配不到,
  紧跟的 `grep -Fq` 失败,`set -e` 打死脚本。日志的表现是「被测行为回归了」,
  实际是**那道变异守卫从此什么也测不到**。

  🔴 它是靠 Docker 套件才暴露的,而 Docker 套件不是每个 PR 都跑。纯文本检查在 PR 期
  就能拦住,几乎不花时间。

判据(刻意保守):只判「PAT 在目标文件里出现」。不判替换后语义对不对 —— 那要跑套件。
   解析不了的 sed 形式**跳过并计数**:一个只说「0 处失效」却不说「跳过了 N 条」的门,
   分母是它自己算出来的,永远自洽。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# `sed -i 's/PAT/REPL/' path` / `sed -i.bak ...`;只收单引号且目标是仓内文件的形式。
SED = re.compile(r"sed -i(?:\.bak)? +'s/(?P<pat>(?:[^/\\]|\\.)*)/(?P<repl>(?:[^/\\]|\\.)*)/[a-z]*' +(?P<file>[A-Za-z0-9_./-]+)")


def unescape(pattern: str) -> str:
    """把 sed 的反斜杠转义还原成字面文本(\\. → . / \\[ → [ …)。"""
    return re.sub(r"\\(.)", r"\1", pattern)


# sed 用的是 **BRE**:只有 . * [ ] ^ $ 和 \( \) \{ \} 是元字符;
# ? + | ( ) { } 在 BRE 里都是**字面量**。把 BRE 直译成 Python 正则,
# 这样含 . 或 ? 的普通代码文本也能判,而不是一律跳过。
def bre_to_regex(pattern: str):
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\" and i + 1 < len(pattern):
            nxt = pattern[i + 1]
            if nxt in "(){}":          # \( \) \{ \} = BRE 的分组/重复
                out.append(nxt if nxt in "{}" else nxt)
            else:
                out.append(re.escape(nxt))
            i += 2
            continue
        if c == "^":
            # BRE: ^ 只在**模式开头**是锚点,别处是字面量
            out.append("^" if i == 0 else re.escape("^"))
        elif c == "$":
            # BRE: $ 只在**模式末尾**是锚点,别处是字面量(模板串 ${x} 全靠这条)
            out.append("$" if i == len(pattern) - 1 else re.escape("$"))
        elif c in ".*[]":
            out.append(c)              # BRE 元字符,原样传给 Python
        else:
            out.append(re.escape(c))   # 其余一律当字面量(含 ? + | ( ) { })
        i += 1
    try:
        return re.compile("".join(out))
    except re.error:
        return None


# 套件在容器里跑,sed 的目标常是 /workspace/… 或 /mutation/… 这类容器内绝对路径,
# 也有相对某个包根的写法。**只试确定的几个前缀,试不出就跳过并计数 —— 不猜。**
def resolve_target(target: str):
    cands = [target]
    for prefix in ("/workspace/", "/mutation/"):
        if target.startswith(prefix):
            cands.append(target[len(prefix):])
    rel = cands[-1]
    tries = [os.path.join(ROOT, c) for c in cands]
    tries += [os.path.join(ROOT, pkg, rel) for pkg in ("agent-node", "agent-network", "server")]
    found = []
    for t in tries:
        if os.path.isfile(t) and t not in found:
            found.append(t)
    # 🔴 多个同名候选(agent-network/src/server.ts 与 server/src/server.ts 都存在)时
    # **不猜**:取第一个会挑错文件,把活着的 pin 报成死的。判为歧义,跳过并计数。
    return found[0] if len(found) == 1 else None


def collect(root: str):
    out = []
    for base, _dirs, files in os.walk(os.path.join(root, "tests")):
        for name in files:
            if name != "run.sh":
                continue
            path = os.path.join(base, name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            for m in SED.finditer(text):
                out.append((path, m.group("pat"), m.group("file")))
    return out



# ── 内联 Python 形态的变异锚点（#1689 实测:sed 形态的取集看不见它）─────────────
# 形如
#     TARGET='  anet config [path|json]       Show config summary…'
#     SRC="$ROOT/server/src/auth.ts"
#     python3 - "$SRC" "$TARGET" "$MUTATED" <<'__MUT__'
#         if source.count(target) != 1: raise SystemExit("mutation target count changed")
# 锚点是**字面量**(不是 BRE),所以判据是 `src.count(target) == 1`,与 sed 那一支不同。
#
# 🔴 只判静态可解的:单引号字面量、以及 $'…' 的 ANSI-C 形式。
#    `TARGET="${arr[1]}"`(shell 变量)与 `TARGET="$X/path.yml"`(目标是文件路径,
#    语义是"在文件里数路径串")**结构上判不了**,计入 skipped 并说明,不静默丢。
PY_TARGET = re.compile(
    r"^TARGET=(?P<q>\$?')(?P<lit>(?:[^'\\]|\\.)*)'\s*$", re.M)
PY_SRC = re.compile(r"^(?:SRC|MUTANT|FILE)=\"\$ROOT/(?P<file>[^\"]+)\"\s*$", re.M)
PY_ARG = re.compile(r"python3 - \"\$ROOT/(?P<file>[^\"]+)\"")


def ansi_c_unescape(s: str) -> str:
    return s.replace("\\n", "\n").replace("\\t", "\t").replace("\\'", "'").replace("\\\\", "\\")


def collect_inline_python(root: str):
    """(run.sh, 字面量锚点 or None, 目标文件 or None) —— None 表示结构上判不了。"""
    out = []
    for base, _dirs, files in os.walk(os.path.join(root, "tests")):
        if "run.sh" not in files:
            continue
        path = os.path.join(base, "run.sh")
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        if "mutation target count changed" not in text:
            continue
        m = PY_TARGET.search(text)
        if not m:
            out.append((path, None, None))          # 变量/路径形态 ⇒ 判不了
            continue
        lit = m.group("lit")
        if m.group("q").startswith("$"):
            lit = ansi_c_unescape(lit)
        sm = PY_SRC.search(text) or PY_ARG.search(text)
        out.append((path, lit, sm.group("file") if sm else None))
    return out


def main() -> int:
    pins = collect(ROOT)
    checked = skipped = 0
    dead = []
    for sh, pat, target in pins:
        rx = bre_to_regex(pat)
        if rx is None:
            skipped += 1
            continue
        full = resolve_target(target)
        if full is None:
            skipped += 1
            continue
        with open(full, encoding="utf-8", errors="replace") as fh:
            src = fh.read()
        checked += 1
        if not rx.search(src):
            dead.append((os.path.relpath(sh, ROOT), target, unescape(pat)))
    # ── 内联 Python 形态（#1689）：锚点是字面量，判据是 count == 1 ──────────────
    inline = collect_inline_python(ROOT)
    inline_checked = inline_skipped = 0
    for sh, lit, rel in inline:
        if lit is None or rel is None:
            inline_skipped += 1
            continue
        full = os.path.join(ROOT, rel)
        if not os.path.isfile(full):
            inline_skipped += 1
            continue
        with open(full, encoding="utf-8", errors="replace") as fh:
            src = fh.read()
        inline_checked += 1
        if src.count(lit) != 1:
            dead.append((os.path.relpath(sh, ROOT), rel,
                         f"[inline-python] count={src.count(lit)} (要求 1): {lit[:80]}"))
    print(f"MUTATION-PIN: 内联 Python 变异 {len(inline)} 条，判定 {inline_checked} 条，"
          f"跳过 {inline_skipped} 条（TARGET 是 shell 变量或指向文件路径，结构上判不了）")
    print(f"MUTATION-PIN: 扫到 {len(pins)} 条 sed 变异，判定 {checked} 条，跳过 {skipped} 条（非字面量或目标不在仓内）")
    if not dead:
        print("MUTATION-PIN: GREEN —— 每条被判定的变异都还能在目标文件里命中。")
        return 0
    print(f"MUTATION-PIN: RED —— {len(dead)} 条打不进去了：")
    for sh, target, pat in dead:
        print(f"  🔴 {sh}")
        print(f"     目标 {target} 里找不到：{pat[:100]}")
    print()
    print("FIX: 被钉的那一行被重构了 ⇒ 那道变异守卫已经变成 NOOP。")
    print("     把 sed 重新指向新的源码文本，**保持语义不变**；不要放宽它后面的断言。")
    return 1


def selftest() -> int:
    ok = fail = 0

    def ck(name, cond):
        nonlocal ok, fail
        print(f"  {'ok  ' if cond else 'FAIL'} {name}")
        ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)

    ck("反转义 \\. → .", unescape(r"a\.b") == "a.b")
    ck("反转义 \\[ → [", unescape(r"args\[1\]") == "args[1]")
    ck("BRE: ? 是字面量,能命中带 ? 的代码", bool(bre_to_regex(r"a?.b").search("a?xb")))
    ck("BRE: \\. 只匹配真的点", bre_to_regex(r"a\.b").search("axb") is None)
    ck("BRE: . 是元字符", bool(bre_to_regex("a.b").search("axb")))
    ck("BRE: 转义过的 [ 当字面量", bool(bre_to_regex(r"args\[1\]").search("args[1]")))
    ck("正控:一个不存在的串判不中", bre_to_regex("zzz_not_here").search("hello") is None)
    ck("BRE: 句中的 $ 是字面量(模板串)", bool(bre_to_regex("a${x}b").search("a${x}b")))
    ck("BRE: 末尾的 $ 仍是锚点", bre_to_regex("ab$").search("abc") is None)
    ck("BRE: 开头的 ^ 仍是锚点", bre_to_regex("^ab").search("xab") is None)
    # 取集:仓里确实有一批 pin —— 分母为 0 会让主判据空过
    ck("取集扫到 ≥10 条 pin", len(collect(ROOT)) >= 10)
    ck("同名多候选判为歧义(不猜)", resolve_target("src/server.ts") is None)
    ck("唯一候选能解析", resolve_target("agent-network/bin/cli.ts") is not None)
    # ── #1689：内联 Python 形态的解析自检 ──────────────────────────────
    # 判据(能不能从 run.sh 里解出锚点)与取集(哪些文件算数)是两层,分开测。
    for label, sh_text, want in [
        ("单引号字面量", "mutation target count changed\nTARGET='abc def'\nSRC=\"$ROOT/x/y.ts\"\n", ("abc def", "x/y.ts")),
        ("ANSI-C 多行",  "mutation target count changed\nTARGET=$'a\\nb'\nSRC=\"$ROOT/p/q.ts\"\n", ("a\nb", "p/q.ts")),
        ("shell 变量",   "mutation target count changed\nTARGET=\"${arr[1]}\"\n", (None, None)),
    ]:
        import tempfile, os as _os
        d = tempfile.mkdtemp(); _os.makedirs(_os.path.join(d, "tests", "t"), exist_ok=True)
        with open(_os.path.join(d, "tests", "t", "run.sh"), "w", encoding="utf-8") as fh:
            fh.write(sh_text)
        rows = collect_inline_python(d)
        got = (rows[0][1], rows[0][2]) if rows else (None, None)
        ck(f"inline: {label} (期望 {want!r} 实得 {got!r})", got == want)
    # 取集自检:真实仓里必须抓到 >=3 条(否则下面的判定恒真)
    ck("inline: 真实仓里抓到 >=3 条(否则 collector 空转)", len(collect_inline_python(ROOT)) >= 3)
    print(f"selftest: {ok} ok / {fail} fail")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
