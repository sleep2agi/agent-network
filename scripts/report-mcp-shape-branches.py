#!/usr/bin/env python3
"""按工具归口「有几个出口形状」—— 给 #3309 的分支维度一个可复算的分母。

口径（引用时必须带）：
  按 `server.tool("name"` 切块，块内 `JSON.stringify({ ok: true …)` 的前 40 字符去重。
  它数的是**源码里的出口形状**，不是「测试走到的出口」⇒ 是**上界**。
  引用时写「源码出口数」，不要写成「需要补的断言数」。
"""
import re, sys, pathlib

src = pathlib.Path(__file__).resolve().parent.parent / "server" / "src" / "tools.ts"
text = src.read_text()
starts = [(m.start(), m.group(1)) for m in re.finditer(r'server\.tool\(\s*"([a-z_]+)"', text)]
starts.append((len(text), None))
rows = []
for i in range(len(starts) - 1):
    s, name = starts[i]; e = starts[i + 1][0]
    block = text[s:e]
    shapes = set()
    for m in re.finditer(r'JSON\.stringify\(\{\s*ok:\s*true([^}]{0,80})', block):
        shapes.add(re.sub(r"\s+", " ", m.group(1))[:40])
    rows.append((name, len(shapes)))

multi = [(n, k) for n, k in rows if k >= 2]
print(f"工具总数 {len(rows)}｜有 ≥2 个成功出口的 {len(multi)} 个｜"
      f"源码出口对合计 {sum(k for _, k in rows)}")
for n, k in sorted(multi, key=lambda x: -x[1]):
    print(f"  {n:34s} {k}")
