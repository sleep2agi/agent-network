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

1. `tools.ts` 里每个 `server.tool("name", …)` / `server.registerTool("name", …)` 的 name，都必须在 mcp-tools.md 的
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
# 🔴 `server.registerTool(` 也要收:用它注册的工具(带严格 schema 的 ack_probe_request / update_provider /
#    requirements_list,#471)原来**结构上看不见** —— 同 test629 修过的那个取集洞。
REGISTRATION = re.compile(r'server\.(?:tool|registerTool)\(\s*\n?\s*"([a-z0-9_]+)"')
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


SELFTEST_EXPECTED = 5


def selftest(quiet: bool = False) -> int:
    """2026-10-31 —— 元门要求每个已接线的门都能 `--selftest`。

    本门的判据有两半都容易假绿：
      ① 索引区**只认表格第一格**（散文里的反引号不是工具名）
      ② 注册点解析不出 ⇒ 分母塌了，必须 exit 2 而不是「没有差集 ⇒ 通过」
    自检在临时目录里造一份最小树，逐条命中这几种形状。
    """
    import tempfile
    fails, ran = 0, 0

    def case(label: str, got, want, ) -> None:
        nonlocal fails, ran
        ran += 1
        if got != want:
            fails += 1
            print(f"✗ {label}: 期望 {want!r}，实际 {got!r}", file=sys.stderr)
        elif not quiet:
            print(f"✓ {label}")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "server" / "src").mkdir(parents=True)
        # 两个注册点：一个 server.tool(...)，一个 server.registerTool(...)
        (root / TOOLS_TS).write_text(
            'server.tool("alpha_tool", "d", {}, async () => ({}));\n'
            'server.registerTool("beta_tool", { description: "d" }, async () => ({}));\n',
            encoding="utf-8",
        )
        case("注册点解析出两个", registered_tools(root), {"alpha_tool", "beta_tool"})

        # 索引区：表格第一格才算；散文里的反引号不算
        doc = (
            "Intro with `not_a_tool` in prose.\n\n"
            "| Tool | What |\n|---|---|\n"
            "| [`alpha_tool`](#alpha) | a |\n"
            "| `beta_tool` | b |\n"
            "\n---\n\n## detail\n| `alpha_tool` | 重复出现的小节，不算索引 |\n"
        )
        (root / "docs").mkdir()
        rel = "docs/mcp-tools.md"
        (root / rel).write_text(doc, encoding="utf-8")
        case("索引只认表格第一格且截止到 ---", indexed_tools(root, rel), {"alpha_tool", "beta_tool"})

        # 散文里的名字必须没有被收进来（否则「索引列全了」会被散文蒙混）
        listed = indexed_tools(root, rel)
        case("散文里的反引号不算工具名", "not_a_tool" in listed, False)

        # 分母塌了：没有注册点 ⇒ registered_tools 为空（调用方据此 exit 2）
        (root / TOOLS_TS).write_text("// no registrations here\n", encoding="utf-8")
        case("没有注册点 ⇒ 空集（分母塌了，不是通过）", registered_tools(root), set())

        # index_region 在没有 --- 时返回全文（不能因为缺分隔线就当成空索引区）
        case("缺 --- 时索引区退回全文", index_region("| `a` | x |"), "| `a` | x |")

    if ran != SELFTEST_EXPECTED:
        print(f"✗ 自检用例数应为 {SELFTEST_EXPECTED}，实际 {ran}", file=sys.stderr)
        return 1
    if fails:
        print(f"✗ 自检失败 {fails} 例", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {ran}/{ran} 通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
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
