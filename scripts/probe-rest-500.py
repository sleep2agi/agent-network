#!/usr/bin/env python3
"""#3969 —— 「真的打过去，不许 500」的探针。

## 为什么需要它

`GET /api/token-usage` 自 `.273` 上线起一直 500（`getNetworkId is not defined`），
两天没人发现。而当时所有检查都通过了：

    表里的行对不对      → 脚本直读 SQLite      ✓
    增量累加对不对      → 对账 0 误差          ✓
    权限对不对          → 节点令牌打 → 403     ✓
    测试里有没有这条路径 → report-rest-visibility ✓

第三条最关键：**403 走的是 handler 前面的分支，根本没执行到 500 那一行**。
第四条只是「测试文件里出现过这个路径的字面量」——它是上界代理，不是「真的发过请求」。

⇒ 缺的是一个真的发出去、并且看响应码的东西。

## 判据

    每条 GET 路由：status ∈ {2xx, 400, 401, 403, 404, 405}  ⇒ 通过
    任何 5xx                                                    ⇒ 失败（代码抛了）
    连不上                                                      ⇒ 退出码 2（没读数，≠ 通过）

5xx 与 4xx 的区别是**归责**：4xx 是调用方做错了（探针没给对参数/身份不够），
5xx 是服务端自己炸了。只有后者值得一个门。

## 边界（写出来，否则会被读成"全绿=全好"）

- **只打 GET**。写路由（POST/PUT/DELETE）不在本探针内：DELETE 打过去是真删。
- 只覆盖 `docs/rest-route-table.json` 里的**字面量路由**；前缀常量/循环注册的那部分
  本来就在可见性门的盲区里（见 report-rest-visibility.py），另卡。
- 2xx 不代表语义正确：探针只回答「这个 handler 会不会炸」，不回答「答案对不对」。
- 参数占位用的是 `probe`：有些路由会因此 404（正常），只要不是 5xx。

## 用法

    ANET_PROBE_TOKEN=utok_… python3 scripts/probe-rest-500.py [--base http://127.0.0.1:9200]
    ANET_PROBE_TOKEN=… python3 scripts/probe-rest-500.py --json   # 机器读

令牌要求：**用户令牌**（节点令牌会在身份门那层被挡成 403，那就测不到 handler 里的东西了）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TABLE = REPO / "docs" / "rest-route-table.json"

# 405 也算通过：说明路由存在但方法不对（那是我们的枚举口径问题，不是服务端炸了）
OK_STATUSES = {200, 201, 202, 204, 400, 401, 403, 404, 405, 406, 409, 410, 422, 429}
# 406 是 /mcp 的合法回答：它要 Accept: text/event-stream，裸 GET 不算错。


def literal_gets() -> list[tuple[str, str]]:
    """(path, method) —— 只要 GET 的字面量路由；`:paramN` 换成 probe。"""
    data = json.loads(TABLE.read_text())
    rows = data.get("rows") or []
    out: list[tuple[str, str]] = []
    for row in rows:
        path = row.get("path") or ""
        method = (row.get("method") or "GET").upper()
        if method != "GET":
            continue
        if not path.startswith("/"):
            continue
        concrete = re.sub(r"/:[A-Za-z0-9_]+", "/probe", path)
        # 正则路由（`?`、括号）在表里已被压成前缀形态，跳过它们：打过去只会得到 404，
        # 而 404 会让人以为"这条路存在但没实现"——那是另一种误导。
        if any(ch in concrete for ch in "()[]?*+"):
            continue
        out.append((concrete, method))
    # 去重（同一 path 多个分支是常见的）
    seen, uniq = set(), []
    for p, m in out:
        if p in seen:
            continue
        seen.add(p)
        uniq.append((p, m))
    return uniq


def probe(base: str, token: str, path: str, timeout: float = 10.0) -> tuple[int, str]:
    req = urllib.request.Request(base.rstrip("/") + path, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        return e.code, body
    except Exception as e:  # 连不上 / 超时
        return 0, str(e)[:120]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("ANET_PROBE_BASE", "http://127.0.0.1:9200"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("ANET_PROBE_TOKEN", "").strip()
    if not token:
        print("退出码 2：没有 ANET_PROBE_TOKEN ⇒ 没有读数（≠ 通过）", file=sys.stderr)
        return 2

    routes = literal_gets()
    if not routes:
        print("退出码 2：路由表里没有可打的 GET（表读不到？）", file=sys.stderr)
        return 2

    results = []
    for path, method in routes:
        status, body = probe(args.base, token, path)
        results.append({"path": path, "method": method, "status": status, "body": body})

    unreachable = [r for r in results if r["status"] == 0]
    server_errors = [r for r in results if 500 <= r["status"] < 600]
    unexpected = [r for r in results if r["status"] not in OK_STATUSES and r["status"] != 0]
    by_status: dict[str, int] = {}
    for r in results:
        key = str(r["status"])
        by_status[key] = by_status.get(key, 0) + 1

    if args.json:
        print(json.dumps({
            "probed": len(results),
            "by_status": by_status,
            "server_errors": server_errors,
            "unexpected": unexpected,
            "unreachable": unreachable,
        }, ensure_ascii=False, indent=2))
    else:
        print(f"探了 {len(results)} 条 GET 路由 · 状态分布 {dict(sorted(by_status.items()))}")
        if server_errors:
            print(f"\n✗ 5xx（服务端自己炸了）：{len(server_errors)} 条")
            for r in server_errors:
                print(f"   {r['status']} {r['path']}  {r['body'][:120]}")
        if unexpected:
            print(f"\n? 不在白名单的状态（多半是新语义，看一眼再决定要不要加）：{len(unexpected)} 条")
            for r in unexpected[:10]:
                print(f"   {r['status']} {r['path']}")
        if unreachable:
            print(f"\n⚠ 打不通：{len(unreachable)} 条（这些**不是通过**，是没有读数）")
            for r in unreachable[:5]:
                print(f"   0 {r['path']}  {r['body'][:80]}")

    # 归责：连不上 / 5xx 才算失败；4xx 是探针自己的参数问题
    if unreachable:
        return 2
    if server_errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
