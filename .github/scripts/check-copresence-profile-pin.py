#!/usr/bin/env python3
"""grok 共存的能力档位必须在**任何** policy/runtime 模块被求值之前钉死。

## 这道门守的是什么

`agent-node/src/runtime/grok-copresence/policy.ts` 的**顶层**就读环境变量:

    export const GROK_COPRESENCE_CAPABILITY_PROFILE =
      readPinnedGrokCopresenceCapabilityProfile();     // 读 ANET_INTERNAL_GROK_COPRESENCE_PROFILE

而 `agent-node/src/cli.ts` 在启动时把它**无条件覆盖**成从节点配置校验出来的值:

    process.env[GROK_COPRESENCE_PROFILE_ENV] = GROK_COPRESENCE_CAPABILITY_PROFILE;

cli.ts 里那段注释写着「Policy/runtime modules are **dynamically imported only after
this boot-time pin**」—— **整个能力边界的正确性挂在这句话上,而没有任何东西在守它。**

🔴 **ESM 的静态 import 是提升的**:`import … from "./runtime/grok-copresence/policy"`
写在文件哪一行都一样,**被导入模块的顶层会在 cli.ts 的第一条语句之前执行**。
也就是说,只要有人在 cli.ts 里加一条静态 import(auto-import 会自动这么做),
`GROK_COPRESENCE_CAPABILITY_PROFILE` 就会**从 ambient 环境变量算出来**,而不是从节点配置。

**它是静默的**:照样编译、类型照样对、单测里先设 env 再 import 也照样绿。
只有在「shell 里恰好有那个变量」的机器上才会表现出来,而表现形式是**能力面被悄悄放宽**。

## 判据

对 `agent-node/src/cli.ts`:

1. **必须存在**那一行无条件的 pin;找不到 → exit 2(不变量本身没了,不是"没问题")。
2. 指向 `grok-copresence/(policy|runtime)` 的 **静态** import → **红**(提升,永远早于 pin)。
   `type X = import("…")` 是类型位置,编译期擦除,放行。
3. 指向它们的 **动态** `await import("…")` 必须出现在 pin 之后。

## 不管什么

不检查 policy.ts 内部逻辑、不检查档位值本身对不对。**它只管「谁先跑」。**

    python3 .github/scripts/check-copresence-profile-pin.py
    python3 .github/scripts/check-copresence-profile-pin.py --selftest
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CLI = Path("agent-node/src/cli.ts")
GUARDED = r"grok-copresence/(?:policy|runtime)"

PIN = re.compile(r"^\s*process\.env\[GROK_COPRESENCE_PROFILE_ENV\]\s*=", re.M)
# 静态 import 的两种写法:`import x from "…"` 和多行 `} from "…";`
STATIC_FROM = re.compile(r'^\s*\}?\s*from\s+["\'][^"\']*' + GUARDED + r'[^"\']*["\']', re.M)
# 🔴 `[^;]` 会跨行,于是多行 import 会被这条和下面的 `} from` 各命中一次,
# 同一条 import 报两遍。改成 `[^;\n]` —— 单行 import 由这条抓,多行 import 由
# STATIC_FROM 抓在它的 `} from "…"` 那一行(那一行也更适合当报错位置)。
# 这个重复是 selftest 第 3 条抓出来的,不是我读出来的。
STATIC_ONELINE = re.compile(r'^\s*import\s+[^;\n]*?from\s+["\'][^"\']*' + GUARDED + r'[^"\']*["\']', re.M)
# 动态 import;`type X = import("…")` 单独识别并放行
DYNAMIC = re.compile(r'(?<!type )\bimport\(\s*["\'][^"\']*' + GUARDED + r'[^"\']*["\']\s*\)')
TYPE_IMPORT = re.compile(r'\btype\s+\w+\s*=\s*import\(\s*["\'][^"\']*' + GUARDED)


# 🔴 传递闭包用的「任意相对 import」——注意它**不带** GUARDED 过滤：
#    上面那三条只认「cli.ts 直接 import 了 policy/runtime」，而 #1009 实测出的缺口是
#    **经由第三个模块到达**：`agent-node/src/runtime/grok-build-cli-home.ts:32` 自己
#    静态 import 了 `./grok-copresence/policy`，所以往 cli.ts 加一条
#    `import … from "./runtime/grok-build-cli-home"` 会传递地在 hoist 阶段求值
#    policy.ts 的顶层 —— 而那条 import 的路径里没有 `grok-copresence/`，
#    于是上面三条一个都不命中，门 rc=0 放行（实测假绿，见 #1009）。
ANY_STATIC_FROM = re.compile(
    r'^\s*\}?\s*from\s+["\'](\.[^"\']+)["\']', re.M)
ANY_STATIC_ONELINE = re.compile(
    r'^\s*(?:import|export)\b[^;\n]*?\bfrom\s+["\'](\.[^"\']+)["\']', re.M)


def resolve_relative(base: Path, spec: str) -> Path | None:
    """把相对 import 指向的说明符解析成真实文件；解析不到返回 None（不猜）。"""
    target = base.parent / spec
    for cand in (target.with_suffix(".ts"), target / "index.ts", target.with_suffix(".tsx")):
        if cand.is_file():
            return cand.resolve()
    return None


def static_closure(entry: Path) -> tuple[set[Path], dict[Path, Path]]:
    """从 entry 出发，只沿**静态** import 边走到底。

    刻意不跟随 `await import(...)` —— 动态 import 正是这道门认可的安全形态，
    跟随它会把所有合规写法也拖进闭包，判据就失去意义。
    """
    seen: set[Path] = set()
    parent: dict[Path, Path] = {}
    frontier = [entry.resolve()]
    while frontier:
        cur = frontier.pop()
        if cur in seen:
            continue
        seen.add(cur)
        try:
            body = cur.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in list(ANY_STATIC_FROM.finditer(body)) + list(ANY_STATIC_ONELINE.finditer(body)):
            nxt = resolve_relative(cur, m.group(1))
            if nxt is None:
                continue
            parent.setdefault(nxt, cur)
            if nxt not in seen:
                frontier.append(nxt)
    return seen, parent


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def analyse(text: str) -> tuple[int | None, list[int], list[int], list[int]]:
    """→ (pin 行号, 静态 import 行号们, 动态 import 行号们, type import 行号们)"""
    m = PIN.search(text)
    pin = line_of(text, m.start()) if m else None
    type_lines = {line_of(text, t.start()) for t in TYPE_IMPORT.finditer(text)}
    static = sorted({line_of(text, s.start()) for s in STATIC_FROM.finditer(text)}
                    | {line_of(text, s.start()) for s in STATIC_ONELINE.finditer(text)})
    dynamic = sorted({line_of(text, d.start()) for d in DYNAMIC.finditer(text)} - type_lines)
    return pin, static, dynamic, sorted(type_lines)


def run() -> int:
    if not CLI.exists():
        print(f"::error::{CLI} not found — scope regression, refusing to pass", file=sys.stderr)
        return 2
    text = CLI.read_text(encoding="utf-8")
    pin, static, dynamic, type_lines = analyse(text)

    if pin is None:
        print("::error::the unconditional `process.env[GROK_COPRESENCE_PROFILE_ENV] = …` pin is gone "
              "from agent-node/src/cli.ts — the capability profile would come from the ambient "
              "environment. This gate refuses to pass rather than report zero problems.", file=sys.stderr)
        return 2

    problems = 0
    for ln in static:
        print(f"::error file={CLI},line={ln}::static import of grok-copresence/policy|runtime. "
              f"ESM static imports are hoisted, so its top level runs BEFORE the profile pin at "
              f"line {pin} — the capability profile would be read from the ambient environment. "
              f"Use `await import(...)` after the pin.")
        problems += 1
    for ln in dynamic:
        if ln < pin:
            print(f"::error file={CLI},line={ln}::dynamic import of grok-copresence/policy|runtime "
                  f"happens before the profile pin at line {pin}.")
            problems += 1

    # 🔴 传递闭包：直接 import 之外的第二条路（#1009）。
    reachable, parent = static_closure(CLI)
    guarded_re = re.compile(GUARDED + r"\.tsx?$")
    hit = sorted(pth for pth in reachable if guarded_re.search(str(pth)))
    for pth in hit:
        # 把到达路径打出来 —— 只说「有一条路」没法改，得说清是哪一条。
        chain, cur = [pth], pth
        while cur in parent and len(chain) < 12:
            cur = parent[cur]
            chain.append(cur)
        arrow = " → ".join(str(c).split("agent-node/src/")[-1] for c in reversed(chain))
        print(f"::error file={CLI}::静态 import 闭包到达了 {pth.name} —— "
              f"它的顶层会在 cli.ts 第一条语句之前求值，档位就会从 ambient 环境变量算出来。"
              f"到达路径：{arrow}。改法：把这条链上第一段换成 `await import(...)`（钉档位之后）。")
        problems += 1

    print(f"pin_line={pin} static_imports={len(static)} dynamic_imports={len(dynamic)} "
          f"type_imports={len(type_lines)} closure_files={len(reachable)} closure_hits={len(hit)}")
    # 分母承重：闭包只有 1 个文件（= 只有 cli.ts 自己）说明相对 import 一条都没解析出来。
    if len(reachable) < 2:
        print("::error::静态 import 闭包只解析出 "
              f"{len(reachable)} 个文件 —— 解析器坏了，不当作通过", file=sys.stderr)
        return 2
    if not dynamic and not static:
        print("::error::no reference to grok-copresence/policy|runtime found in cli.ts at all — "
              "either the runtime was removed or this gate's pattern stopped matching. "
              "Refusing to pass on an empty denominator.", file=sys.stderr)
        return 2
    if problems:
        print(f"\n{problems} problem(s).")
        return 1
    print("every policy/runtime import is dynamic and lands after the boot-time profile pin.")
    return 0


# --- selftest -----------------------------------------------------------
# 夹具里的路径用拼接构造,避免这个文件自身被同类扫描器误判。
def selftest() -> int:
    G = "grok-copresence/"
    PINLINE = "process.env[GROK_COPRESENCE_PROFILE_ENV] = X;\n"
    cases = []

    def check(name, text, want_pin, want_static, want_dyn_before):
        pin, static, dynamic, _t = analyse(text)
        got = (pin is not None, len(static), len([d for d in dynamic if pin and d < pin]))
        ok = got == (want_pin, want_static, want_dyn_before)
        cases.append((name, ok, f"pin={pin} static={static} dyn={dynamic}"))

    check("干净形状:pin 在前,动态 import 在后",
          f'import {{ a }} from "./runtime/{G}profile-selection";\n{PINLINE}'
          f'const m = await import("./runtime/{G}runtime");\n', True, 0, 0)
    check("🔴 单行静态 import → 记为 static",
          f'import {{ P }} from "./runtime/{G}policy";\n{PINLINE}', True, 1, 0)
    check("🔴 多行静态 import(`}} from` 收尾)→ 记为 static",
          'import {\n  P,\n} from "./runtime/' + G + 'policy";\n' + PINLINE, True, 1, 0)
    check("type import 不算(编译期擦除)",
          f'type S = import("./runtime/{G}runtime").Session;\n{PINLINE}'
          f'await import("./runtime/{G}runtime");\n', True, 0, 0)
    check("🔴 动态 import 跑在 pin 之前",
          f'await import("./runtime/{G}policy");\n{PINLINE}', True, 0, 1)
    check("pin 消失 → pin=None(上游 exit 2)",
          f'await import("./runtime/{G}runtime");\n', False, 0, 0)
    check("profile-selection 是静态也没关系(它不读 env)",
          f'import {{ a }} from "./runtime/{G}profile-selection";\n{PINLINE}'
          f'await import("./runtime/{G}runtime");\n', True, 0, 0)

    # --- 闭包那一层单独自检（真造目录树，不能只喂一段文本）---
    # 上面 7 条只验 analyse()，它看的是 cli.ts 一个文件的内容；
    # 闭包判据要跨文件，所以夹具必须是真文件 —— 用一段字符串喂不出「A import B、
    # B import C」这个形状。这也是 #1009 那个缺口能存在的原因：单文件视角看不见它。
    import tempfile

    def check_closure(name, files, want_hit):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            for rel, body in files.items():
                f = base / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(body, encoding="utf-8")
            reachable, _parent = static_closure(base / "cli.ts")
            guarded_re = re.compile(GUARDED + r"\.tsx?$")
            hit = [x for x in reachable if guarded_re.search(str(x))]
            ok = (len(hit) > 0) == want_hit
            cases.append((name, ok, f"closure={len(reachable)} hits={len(hit)}"))

    G2 = "runtime/" + G
    check_closure("🔴 传递静态 import 到达 policy（#1009 的那个形状）", {
        "cli.ts": 'import { x } from "./runtime/grok-build-cli-home";\n',
        "runtime/grok-build-cli-home.ts": 'import { P } from "./' + G + 'policy";\nexport const x = 1;\n',
        G2 + "policy.ts": "export const P = 1;\n",
    }, True)
    check_closure("动态 import 不被跟随（这是合规形态）", {
        "cli.ts": 'const m = await import("./runtime/grok-build-cli-home");\n',
        "runtime/grok-build-cli-home.ts": 'import { P } from "./' + G + 'policy";\nexport const x = 1;\n',
        G2 + "policy.ts": "export const P = 1;\n",
    }, False)
    check_closure("中间模块只 import 无关文件 → 不该命中", {
        "cli.ts": 'import { x } from "./runtime/grok-build-cli-home";\n',
        "runtime/grok-build-cli-home.ts": 'import { y } from "./other";\nexport const x = 1;\n',
        "runtime/other.ts": "export const y = 1;\n",
        G2 + "policy.ts": "export const P = 1;\n",
    }, False)

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}   [{detail}]")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else run())
