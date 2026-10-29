#!/usr/bin/env python3
"""#2970 判据① —— 「每条节点路由都有明确的一类门」要能自动检查，而不是靠人肉枚举。

现在的事实是：节点令牌能到的 REST 路由分散在两处（`restNodeDenied` 与 `nodeTaskGate`），
我这一轮是靠 grep 手工数出 9 条写路由 + 2 条 SSE。**人肉数过的清单，下一个人加路由时不会自动更新。**

这个脚本做三件事：

1. 从源码里抽出所有「节点判定点」的路由标签（两个函数名各一套正则）
2. 与脚本里登记的 EXPECTED 集合逐字比对 —— 多一条、少一条都红
3. 检查被登记的写路由是否都在 REST 白名单的文档清单里（文档与代码不许分叉）

红了怎么办：
  · 新加了一条节点路由 ⇒ 把它加进 EXPECTED，并问一句「它要不要进 rest_allowlist 的候选清单」
  · 删了一条 ⇒ 从 EXPECTED 删掉（顺便确认没有别处还在引用这个标签）

用法：
  python3 .github/scripts/check-node-rest-route-classification.py
  python3 .github/scripts/check-node-rest-route-classification.py --selftest
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]

# 节点令牌能到的 REST 路由，按**判定入口**分类。
# 讨论背景：#3020（单一 choke point）、#2969（rest_allowlist）。
EXPECTED = {
    # server.ts —— restNodeDenied(req, authCtx, "<label>", verdictOf)
    "POST /api/task",
    "POST /api/broadcast",
    "DELETE /api/nodes/:id",
    "PUT /api/nodes/:id/attrs",
    "PUT /api/nodes/:id/avatar",
    "SSE /events/:session",
    "SSE /events/network/:id",
    # requirements.ts —— nodeTaskGate(ctx, "<label>", ...)
    "POST /api/requirements",
    "POST /api/requirements/:id/comments",
    "PATCH /api/requirements/:id",
    "PATCH /api/requirements/:id/checklist/:id",
}

# 其中属于「写方法」的那些 —— rest_allowlist 只对它们生效（GET/SSE 永不经过）。
WRITE_EXPECTED = {l for l in EXPECTED if not l.startswith("SSE ")}

REST_NODE_DENIED_RE = re.compile(r'restNodeDenied\(\s*req\s*,[^,]+,\s*"([^"]+)"')
NODE_TASK_GATE_RE = re.compile(r'nodeTaskGate\(\s*ctx\s*,\s*"([^"]+)"')
# 账号级/人级判定不算节点路由；显式排除以免误报。
# （写在这里是为了记录「我知道还有别的门，它们不在这张清单的范围内」。）


def scan(paths: list[pathlib.Path]) -> set[str]:
    labels: set[str] = set()
    for p in paths:
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        labels.update(REST_NODE_DENIED_RE.findall(text))
        labels.update(NODE_TASK_GATE_RE.findall(text))
    return labels


def documented_labels() -> set[str]:
    """文档里那张「可拦路由」表 —— 与代码必须一致。"""
    found: set[str] = set()
    for rel in ("docs-site/docs/guide/multi-user.md", "docs-site/docs/en/guide/multi-user.md"):
        p = ROOT / rel
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"^(POST|PUT|PATCH|DELETE)\s+(/api/\S+)$", text, re.MULTILINE):
            found.add(f"{m.group(1)} {m.group(2)}")
    return found


def selftest() -> int:
    failures: list[str] = []

    def check(name: str, got, want) -> None:
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    sample = '''
      const d = restNodeDenied(req, restAuth, "PUT /api/nodes/:id/attrs", (id) => writeVerdict(id));
      const d2 = restNodeDenied(req, restAuth, "POST /api/task", (id) => dispatchVerdict(id, {}));
      if (url.pathname === "/x") { const g = nodeTaskGate(ctx, "PATCH /api/requirements/:id", row); }
      const unrelated = someOtherGate(ctx, "NOT /a/node/route");
    '''
    tmp = pathlib.Path("/tmp/_route_scan_sample.ts")
    tmp.write_text(sample, encoding="utf-8")
    try:
        got = scan([tmp])
    finally:
        tmp.unlink(missing_ok=True)
    check("只收两个门函数的标签", got,
          {"PUT /api/nodes/:id/attrs", "POST /api/task", "PATCH /api/requirements/:id"})
    # 写方法集合不能把 SSE 算进去 —— rest_allowlist 只对写方法生效
    check("SSE 不在写方法集合", any(l.startswith("SSE ") for l in WRITE_EXPECTED), False)
    check("写方法集合非空", len(WRITE_EXPECTED) > 0, True)

    for f in failures:
        print(f"FAIL: {f}")
    print("node-rest-route-classification selftest: %s (%d 条判据)"
          % ("FAILED" if failures else "OK", 3))
    return 1 if failures else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    actual = scan([ROOT / "server/src/server.ts", ROOT / "server/src/requirements.ts"])
    problems: list[str] = []

    missing = EXPECTED - actual          # 登记了但代码里没有（可能是改名/删了）
    added = actual - EXPECTED            # 代码里有但没登记（最危险：新路由没人分类）
    if missing:
        problems.append("登记了但源码里找不到（改名或删除？）：\n" + "\n".join(f"  - {l}" for l in sorted(missing)))
    if added:
        problems.append(
            "源码里有但没登记（新加的节点路由必须先决定它归哪一类门）：\n"
            + "\n".join(f"  + {l}" for l in sorted(added)))

    documented = documented_labels()
    if documented:
        undocumented = WRITE_EXPECTED - documented
        stale = documented - WRITE_EXPECTED
        if undocumented:
            problems.append("文档里缺这些可拦写路由：\n" + "\n".join(f"  - {l}" for l in sorted(undocumented)))
        if stale:
            problems.append("文档里有代码中不存在的路由：\n" + "\n".join(f"  + {l}" for l in sorted(stale)))

    if problems:
        for p in problems:
            print(f"::error::{p}")
        print(f"\n共 {len(EXPECTED)} 条登记 / {len(actual)} 条实际 / {len(WRITE_EXPECTED)} 条写路由")
        return 1

    print(f"OK: {len(actual)} 条节点路由全部有登记（其中写路由 {len(WRITE_EXPECTED)} 条），文档与代码一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
