#!/usr/bin/env python3
"""每个错误码的**生产者数**：一个码被多少个地方产出。

## 为什么这个数值得单独看

今晚的每一次误判都能被同一个数字提前拦住：

  · 「1 键」—— 同一路由的 401/400/403 三个生产者共用一个形状
  · `diagnosticId` —— 客户端与服务端各有一份判据（两个生产者）
  · `runtime_transport_connection_failed` —— 本地断开与上游连不上共用
  · `runtime_sdk_csrf_invalid` —— 9 个条件共用一个 403，闸门还有 4 份不一致副本

⇒ 共同点：**判据假设"一个码一个原因"，而码其实是若干条件的并集。**
⇒ 而这件事可以数：**每个码有几个产出点。**

## 判据（不是门，是报表）

本脚本是**报表**（退出码恒 0）。它回答的是「哪些码不适合用来定因」：
  · 生产者 1 个      ⇒ 可以用来定因
  · 生产者 2 个      ⇒ 需要附加字段（如 cause / stage）才能定因
  · 生产者 ≥3 个     ⇒ **只能用来报警，不能用来定因**（36 种成因那种）

## 口径与盲区（必须打印，否则数字会被当成全覆盖）

  · 只认 `code: "<字面量>"` 与 `error: "<字面量>"` 两种写法 ⇒ 变量拼接的码抓不到
  · 只扫非测试源文件（测试里的字面量是期望值，不是生产者）
  · 「同一行出现两次」只算一次
⇒ 所以是**下界**：真实生产者数 ≥ 本报表的数。
"""
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

CODE_LITERAL = re.compile(r'\b(?:code|error)\s*:\s*"([a-z][a-z0-9_]{2,60})"')
SRC = (".ts", ".mts", ".js", ".mjs")


def files(repo: Path) -> list[Path]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=repo, check=True, capture_output=True)
    picked = []
    for rel in out.stdout.decode("utf-8", "replace").split("\0"):
        if not rel or rel.startswith("node_modules/"):
            continue
        if not rel.endswith(SRC):
            continue
        if ".test." in rel or ".spec." in rel:
            continue
        picked.append(repo / rel)
    return sorted(picked)


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    sites: dict[str, set[str]] = defaultdict(set)   # code -> set("file:line")
    per_file: dict[str, int] = defaultdict(int)
    scanned = 0
    dynamic_hint = 0

    for path in files(repo):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        scanned += 1
        rel = str(path.relative_to(repo))
        for lineno, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith(("//", "*", "/*")):
                continue
            codes = set(CODE_LITERAL.findall(line))
            for code in codes:
                sites[code].add(f"{rel}:{lineno}")
            # 变量拼接的码（`code: someVar`）算不出来 —— 只计数，让人知道盲区多大
            if re.search(r"\b(?:code|error)\s*:\s*(?!\")(\w+|\$|`|\()", line) and not codes:
                dynamic_hint += 1
        per_file[rel] = sum(len(v) for k, v in sites.items() if any(s.startswith(rel + ":") for s in v))

    print(f"扫描 {scanned} 个非测试源文件；识别到 {len(sites)} 个码名")
    print(f"盲区：{dynamic_hint} 处 `code/error` 用了变量拼接（抓不到）⇒ 本报表是**下界**")
    print()

    ranked = sorted(sites.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    many = [(c, s) for c, s in ranked if len(s) >= 3]
    two = [(c, s) for c, s in ranked if len(s) == 2]

    print(f"生产者 ≥3 的码：{len(many)} 个 —— **只能用来报警，不能用来定因**")
    for code, s in many[:15]:
        print(f"  {code:44s} {len(s):3d} 处")
        for loc in sorted(s)[:3]:
            print(f"       {loc}")
        if len(s) > 3:
            print(f"       …（共 {len(s)} 处）")
    print()
    print(f"生产者 ==2 的码：{len(two)} 个 —— 需要附加字段（cause/stage）才能定因")
    for code, s in two[:10]:
        print(f"  {code:44s} {len(s):3d} 处")
    print()
    print(f"生产者 ==1 的码：{len(ranked) - len(many) - len(two)} 个 —— 可以用来定因")
    print("（报表：退出码恒 0；它回答「哪些码不适合定因」，不是「有没有违规」）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
