#!/usr/bin/env python3
"""这个路径到底在哪一层？—— 先在源码里 grep 那个字面串，再谈权限/路由。

## 为什么把它做成命令

2026-11-05 同一天里我犯了两次同一个错：

    「/api/hub/requirements/projects 返回 404 ⇒ 路径写错了」
    「/api/v1/admin/spaces/network 返回 401 ⇒ 缺 admin scope」

两次都是**先假定它在 Hub 里有一条路由**，然后拿状态码去解释。
真相是两次都不在这仓里：一次是客户端的 Next 代理（最终转发 /mcp），
一次是门户仓的路由，Hub 根本没有这两条路径。

一次错是疏忽，两次错是缺工具。所以这条判断变成命令：

    python3 scripts/where-is-route.py /api/hub/requirements/projects

## 判读规则（写死在输出里，不靠记）

    命中 server/src/server.ts 的 `url.pathname ===/match(...)`  ⇒ 是 Hub 的 REST 路由
    命中 server/src/tools.ts 的 server.tool("<name>")            ⇒ 是 MCP 工具（走 /mcp）
    两处都不中                                                   ⇒ 不在本仓（客户端代理 / 别的仓）
    都不中，但**前缀相近**的路由存在                              ⇒ 很可能是「被 :param 吃掉」

最后一条是门户那次的关键：`/api/v1/admin/spaces/network` 会被 `/api/v1/admin/spaces/:name`
接住（name=network），于是它「看起来存在」，只是走到了错的分支。

退出码：0 = 在本仓找到（REST 或 MCP）；1 = 不在本仓；2 = 用法错误
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SERVER = REPO / "server" / "src" / "server.ts"
TOOLS = REPO / "server" / "src" / "tools.ts"
CLIENT_HINTS = ("agent-network-app", "portal", "dashboard")


def lines_with(path: Path, needle: str) -> list[tuple[int, str]]:
    if not path.exists():
        return []
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if needle in line:
            out.append((i, line.strip()[:160]))
    return out


def rest_routes() -> list[tuple[int, str, str]]:
    """把所有路由取成 (行号, 原始形态, 正则)。两种写法都要——只认字面串会漏掉 :param。"""
    if not SERVER.exists():
        return []
    out: list[tuple[int, str, str]] = []
    for i, line in enumerate(SERVER.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        for m in re.finditer(r'url\.pathname === "([^"]+)"', line):
            raw = m.group(1)
            out.append((i, raw, "^" + re.escape(raw) + "$"))
    # match 形态单独扫全文件：一行里可能跨多个条件，用非贪婪到 `/,` 或 `/)` 收尾
    text = SERVER.read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r'url\.pathname\.match\((/\^.*?\$/)[,)]', text, re.S):
        line = text[:m.start()].count("\n") + 1
        literal = m.group(1)
        src = literal[1:-1].replace("\\/", "/")
        out.append((line, literal[:120], src if src.endswith("$") else src + "$"))
    return out


def route_matches(path: str) -> list[tuple[int, str]]:
    """按**正则**判兼容 —— 关键一步：`/api/nodes/n_x/config` 只能被
    `/^\/api\/nodes\/([^/]+)\/config$/` 命中，字面 grep 永远找不到它。"""
    hits = []
    for line, raw, src in rest_routes():
        try:
            if re.match(src, path):
                hits.append((line, raw))
        except re.error:
            continue
    return hits


def tool_names() -> list[tuple[int, str]]:
    if not TOOLS.exists():
        return []
    out = []
    for i, line in enumerate(TOOLS.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        m = re.match(r'\s*"([a-z][a-z0-9_]{2,})",\s*$', line)
        if m:
            out.append((i, m.group(1)))
    return out


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2
    needle = sys.argv[1]
    bare = needle.strip("/").split("/")[-1]

    print(f"查：{needle}\n")

    rest_hits = lines_with(SERVER, needle)
    tool_hits = lines_with(TOOLS, needle)
    pattern_hits = route_matches(needle)
    print(f"server/src/server.ts 字面命中 {len(rest_hits)} 处")
    for i, line in rest_hits[:5]:
        print(f"  L{i}: {line}")
    print(f"server/src/tools.ts   字面命中 {len(tool_hits)} 处")
    for i, line in tool_hits[:5]:
        print(f"  L{i}: {line}")

    # MCP 工具名前缀推测：/api/hub/requirements/projects ⇒ requirements_*
    plausible = [n for _, n in tool_names() if bare and bare.rstrip("s") in n]
    if plausible:
        print(f"\n相近的 MCP 工具（可能就是这个端点真正转发的目标）：{', '.join(sorted(set(plausible))[:8])}")

    if pattern_hits:
        print(f"\n按**路由正则**匹配到 {len(pattern_hits)} 条（字面 grep 找不到，但请求会走到这里）：")
        for i, raw in pattern_hits[:6]:
            print(f"  L{i}: {raw}")

    prefixes = {"/".join(needle.strip("/").split("/")[:3])}
    near = [(i, p) for i, p, _src in rest_routes() if any(p.startswith(pref) for pref in prefixes)]
    if near and not rest_hits:
        print("\n⚠ 前缀相近的 REST 路由存在，但都不是这个字面路径：")
        for i, p in near[:8]:
            print(f"  L{i}: {p}")
        print("  ⇒ 很可能被某个 :param 路由接住（『路径不存在』会表现成 401/404/400）")

    found = bool(rest_hits or tool_hits or pattern_hits)
    if found:
        print("\n结论：**在本仓**。先看上面那一行守卫/工具，再谈权限。")
        return 0
    print("\n结论：**不在本仓**。")
    print("  · 若客户端/门户有自己的仓（" + " / ".join(CLIENT_HINTS) + "），它可能是那里的代理或路由；")
    print("  · 本仓的 MCP 工具走 /mcp，不占用 /api/… 路径；")
    print("  · 不要用状态码反推层级——那正是这条命令要替代的做法。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
