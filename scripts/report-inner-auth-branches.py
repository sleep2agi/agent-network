#!/usr/bin/env python3
"""handler 内的鉴权分支：哪些**可达**，哪些可能永远不执行。

## 起因（#3365）

两次实测撞到同一形状：把 handler 内那条 401 短路掉，测试**仍然绿**。

    POST /api/messages/ack：`if (!callerUserId) return 401 auth_required`
      ⇒ 实测未认证响应体是 {"error":"unauthorized"}（全局层），不是 {"ok":false,...,"auth_required"}
    POST /api/upload：`case "anonymous": return 401 auth_required`
      ⇒ 源码那一行自己写着 "Unreachable: requireAuth above already 401s"

后果不是 bug，而是**读数失真**：这些分支在覆盖率里算「已覆盖的拒绝路径」（有断言、绿），
而真正的拒绝发生在另一层 —— 那一层改松时它们不会动。

## 这份脚本给什么（以及不给什么）

给：handler 内所有「鉴权/权限拒绝」分支的**清单 + 行号 + 形态分类**。
不给：「可达性证明」—— 本仓没有可枚举的中间件栈，可达性只能靠**逐个变异实验**
（改一处，跑测试，看红不红）。所以本脚本把可达性一栏留成 `unverified`，
并单独列出**已做过变异实验**的几条（那几条有结论）。

## 用法

    python3 scripts/report-inner-auth-branches.py [--assert]

`--assert`：形态计数只许降（棘轮上线后由 --baseline 固化）；现在只报告。
退出码：0 = 有读数；2 = 读不到源码。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "server" / "src" / "server.ts"

# 形态：handler 里的鉴权/权限拒绝。
BRANCH_PATTERNS = (
    ("not_authenticated", re.compile(r'if \(!\w+\) return [^;]*\{\s*ok: false, error: "auth required"')),
    ("not_authenticated", re.compile(r'if \(!callerUserId\)')),
    ("user_token_required", re.compile(r'if \(isNodeCredential\([^)]*\)\) return userTokenRequired\(req\)')),
    ("user_token_required", re.compile(r'if \(restAuth\.networkId\) return userTokenRequired\(req\)')),
    ("user_token_required", re.compile(r'if \(resolved\.networkId\) return withCors\(req, Response\.json\(\{ ok: false, error: "user_token_required"')),
    ("permission_denied", re.compile(r'canRestWriteNetwork\([^)]*\)\) \{\s*$')),
)

# 已经做过「短路这一支 ⇒ 跑测试 ⇒ 看红不红」实验的那些（结论要写明依据）。
PROBED = {
    # 2026-11-01 —— 第三档：**unpinned**（短路后没有测试变红）。
    # 它既不是 reachable（没测试守它）也不是 unreachable（可能只是没测），
    # 而两者在「短路后仍绿」这个读数上完全同形 —— 所以单列一档，不合并。
    # 2026-11-01 升级：这六条从 unpinned 改判 **unreachable**，证据是**响应体形状**：
    # 未认证请求回来的是 {"error":"unauthorized"}（全局层），不是 handler 的
    # {"ok":false,"error":"auth required"} ⇒ 处理那一条分支从来没有机会执行。
    # （此前只有「短路后不红」这一个读数，它推不出这一句。）
    "L4222 /api/nodes/:id/tool-allowlist (!restAuth)": ("unreachable", "短路后 0 红；未认证响应体是全局层 unauthorized"),
    "L4343 /api/nodes/:id/rest-allowlist (!restAuth)": ("unreachable", "同上"),
    "L4460 /api/nodes/:id/peer-allowlist (!restAuth)": ("unreachable", "同上"),
    # 2026-11-01 第二批：三个 provider/节点区间里的 !restAuth 分支，
    # 各跑两个最可能的测试文件（hub-catalog-read / node-permissions），都是 0 条红。
    "L4070 (!restAuth)": ("unreachable", "短路后 0 红；/api/nodes 未认证响应体是全局层 unauthorized"),
    "L4098 (!restAuth)": ("unreachable", "同上（/api/providers）"),
    "L4166 (!restAuth)": ("unreachable", "同上（/api/nodes/:id/permission-mode）"),
    "POST /api/messages/ack": ("unreachable", "短路该支后测试仍绿；实测响应体是全局层的 unauthorized"),
    "POST /api/upload": ("unreachable", '短路 case "anonymous" 后测试仍绿；源码注释自称 Unreachable'),
    "POST /api/auth/tokens": ("reachable", "短路后 reds=1（可隔离 witness）"),
    "POST /api/networks/join": ("reachable", "短路后 reds=1"),
    "POST /api/networks": ("reachable", "短路后 reds=1（连坐 2）"),
    "POST /api/node-rename/abort": ("reachable", "短路 nodeMayRenameTxn 后 reds=1"),
    "PUT /api/auth/me": ("reachable", "同文件 403 测试红"),
}


def selftest() -> int:
    """三例：形态能命中 / 归属能跟上路由 / 不给可达性结论。

    第三例是这条脚本的**边界**：它必须看起来就不像「已验证可达」，
    否则读者会把「清单里有它」读成「它真的会执行」。
    """
    cases: list[int] = []
    sample = [
        'if (url.pathname === "/api/demo") {',
        '  if (!restAuth) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));',
        '  if (isNodeCredential(resolved)) return userTokenRequired(req);',
        '}',
    ]
    hits = [(i, kind) for i, line in enumerate(sample, 1) for kind, pat in BRANCH_PATTERNS if pat.search(line)]
    ok = len(hits) == 2
    print(("✓" if ok else "✗") + f" selftest 两种形态各命中一次（命中 {len(hits)} 次）")
    cases.append(0 if ok else 1)

    ok = re.search(r'url\.pathname\s*===?\s*"([^"]+)"', sample[0]) is not None
    print(("✓" if ok else "✗") + " selftest 能从路由判定行取出路径（归属用）")
    cases.append(0 if ok else 1)

    ok = "可达性" in __doc__ and "不给" in __doc__
    print(("✓" if ok else "✗") + " selftest 文档明说「不给可达性结论」")
    cases.append(0 if ok else 1)

    fails = sum(cases)
    print(f"✓ selftest {len(cases) - fails}/{len(cases)} 通过")
    return 0 if fails == 0 else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if not SOURCE.exists():
        print(f"✗ 读不到 {SOURCE.relative_to(REPO)}", file=sys.stderr)
        return 2
    lines = SOURCE.read_text(encoding="utf-8", errors="replace").splitlines()

    # 逐行找形态；同时记下「最近一个 url.pathname 判定」作为归属（文本级近似）
    rows: list[dict] = []
    route = "（未归属）"
    for i, line in enumerate(lines, 1):
        m = re.search(r'url\.pathname\s*===?\s*"([^"]+)"', line) or re.search(r'url\.pathname\.match\(/\^\\/([^/\\$?(]+)', line)
        if m and "/api/" in line or (m and m.group(1).startswith("api")):
            route = m.group(1)
        for kind, pat in BRANCH_PATTERNS:
            if pat.search(line):
                rows.append({"line": i, "route": route, "kind": kind})
                break

    print(f"server/src/server.ts 内「鉴权/权限拒绝」分支：{len(rows)} 处")
    by_kind: dict[str, int] = {}
    for r in rows:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    print("  形态分布：" + " · ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))
    print()
    print("  可达性：**本脚本不给结论**（本仓没有可枚举的中间件栈）。")
    print("  结论只能来自「短路这一支 ⇒ 跑测试 ⇒ 看红不红」的逐个实验。已做过的：")
    for route, (verdict, why) in sorted(PROBED.items()):
        print(f"    {verdict:<11} {route:<34} {why}")
    print()
    print("  未做实验的分支（默认按「可能可达」对待，不按「死代码」删）：")
    unprobed = [r for r in rows if not any(p.split(" ")[-1] in r["route"] for p in PROBED)]
    print(f"    {len(unprobed)} 处 —— 需要逐个变异才能定性")
    print("  mutates: none（只读）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
