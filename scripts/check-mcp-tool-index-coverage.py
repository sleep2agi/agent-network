#!/usr/bin/env python3
"""mcp-tools.md 的索引必须列全 server/src/tools.ts 注册的每一个 tool。

⚠️ 仓里关于 mcp-tools.md 有**两道**门，判据不同，不要弄混：

    scripts/check-mcp-tool-anchor-sections.py  —— 锚串**落在对的 tool 段**里
    scripts/check-mcp-tool-index-coverage.py(本文件) —— 索引**列全了**每个 tool

两者互不覆盖：一份索引可以每条锚点都正确，同时漏掉 27 个工具；反过来也成立。

## 这道门为什么存在

2026-08-26 实测：`server/src/tools.ts` 注册 **44** 个 tool，而 `mcp-tools.md`
只写了 17 个，页首用「约 40 个」「约 22 个」这种含糊说法带过，并且点名了一个
**代码里根本不存在**的 `update_provider`。

漏写不会让任何东西变红 —— 文档少一行，读者只是不知道有这个能力。#173 就是这么来的：
`send_reply` 支持 `attachments`（#507 起），参考页的参数表没写，于是全网 agent 都把
`file_id` 贴进正文，桌面端把它当散文渲染。**一张参考表少一行，是没人知道这个能力存在的全部原因。**

## 判据

1. `tools.ts` 里每个 `server.tool("name", …)` 的 name，都必须在 mcp-tools.md 的
   **索引区**（页首到第一个 `---` 之间）出现为 `` `name` `` 或 `` [`name`](#name) ``。
2. 索引里出现的每个反引号工具名，都必须真的在 `tools.ts` 里注册过 —— 挡住
   `update_provider` 那种「文档点名了一个不存在的工具」。
3. 中英两页同时检查，且**两边的工具集合必须一致** —— 只更新一边是这类页面最常见的失效。
4. 分母必须非零：解析不出注册点、或索引区为空，都直接判红，不许空扫成绿。

退出码 0 = 全部通过；1 = 有差集；2 = 分母塌了（比 1 更严重，说明这道门没在看东西）。
"""

import re
import sys
from pathlib import Path

DOC_PATHS = [
    "docs-site/docs/api/mcp-tools.md",
    "docs-site/docs/en/api/mcp-tools.md",
]
TOOLS_TS = "server/src/tools.ts"

# `server.tool(` 后面第一个字符串字面量就是 tool 名；注册点可能换行。
# 🔴 字符类必须含数字：写成 [a-z_]+ 时 `probe_v2` 这类名字**看不见**，
#    这道门会少算一个却仍然报绿 —— 盲区在「怎么把要判的东西收进来」，不在判据。
#    2026-08-26 就是靠一次带数字的变异存活才发现的。
REGISTRATION = re.compile(r'server\.tool\(\s*\n?\s*"([a-z0-9_]+)"')
# 索引区里的工具名：`name` 或 [`name`](#name)
INDEX_NAME = re.compile(r'\[?`([a-z0-9_]+)`')


def registered_tools(root: Path) -> set[str]:
    src = (root / TOOLS_TS).read_text(encoding="utf-8", errors="replace")
    return set(REGISTRATION.findall(src))


def index_region(text: str) -> str:
    """页首到第一个水平分隔线 —— 详细小节从那之后开始，不算索引。"""
    marker = text.find("\n---\n")
    return text if marker < 0 else text[:marker]


def indexed_tools(root: Path, rel: str) -> set[str]:
    """只认表格行的**第一格**。

    索引区的散文里也会出现反引号（分组标题写着「`anet` CLI / Dashboard 调用」），
    把整片区域一起 findall 会把 `anet` 当成 tool 名，在干净树上就误报。
    误拦的门比漏拦的门更糟——它教人绕过。工具名只出现在表格第一列，就只看那里。
    """
    text = (root / rel).read_text(encoding="utf-8", errors="replace")
    found: set[str] = set()
    for line in index_region(text).splitlines():
        if not line.startswith("|"):
            continue
        first_cell = line.split("|")[1] if line.count("|") >= 2 else ""
        found.update(INDEX_NAME.findall(first_cell))
    return found


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

    registered = registered_tools(root)
    print(f"tool_registrations={len(registered)}")
    if not registered:
        print("FAIL: 解析不出任何 server.tool 注册点 —— 分母塌了，这道门没在看东西", file=sys.stderr)
        return 2

    failures: list[str] = []
    per_doc: dict[str, set[str]] = {}

    for rel in DOC_PATHS:
        path = root / rel
        if not path.exists():
            failures.append(f"{rel}: 文件不存在")
            continue
        listed = indexed_tools(root, rel)
        per_doc[rel] = listed
        print(f"indexed[{rel}]={len(listed)}")
        if not listed:
            print(f"FAIL: {rel} 的索引区一个工具名都没有 —— 分母塌了", file=sys.stderr)
            return 2

        missing = sorted(registered - listed)
        if missing:
            failures.append(
                f"{rel}: 索引漏了 {len(missing)} 个已注册的 tool: {', '.join(missing)}"
            )
        ghost = sorted(listed - registered)
        if ghost:
            failures.append(
                f"{rel}: 索引点名了 {len(ghost)} 个 tools.ts 里不存在的 tool: {', '.join(ghost)}"
            )

    # 只更新一边是这类双语页最常见的失效，所以单独判一次。
    if len(per_doc) == 2:
        (a_rel, a), (b_rel, b) = per_doc.items()
        drift = sorted(a ^ b)
        if drift:
            failures.append(
                f"中英两页索引的工具集合不一致，差集 {len(drift)} 个: {', '.join(drift)}"
            )

    if failures:
        for line in failures:
            print(f"FAIL: {line}", file=sys.stderr)
        return 1

    print(f"OK: {len(DOC_PATHS)} 份文档的索引各自列全了全部 {len(registered)} 个 tool，且无幽灵条目。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
