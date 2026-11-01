#!/usr/bin/env python3
"""每条**写路由**的门：名字从源码抽，不靠人背下来的那张表。

## 为什么需要（#3346）

为 `#3314` 复核写路由的门时，第一遍用我手写的 11 个门符号去扫 if 块，
结果是「31 条写路由里 10 条无门」。逐个人读源码后 ⇒ **10 条全是假阴性**：

    canRestWriteNetwork / restNodeDenied / requireTmuxAccess 不在那张手写表里

⇒ 手写符号表让扫描结果永远是**下界**，而「扫不到」与「没有」在报表上同形。
这与「否定断言必须配镜像肯定断言」是同一条：这里缺的是**门符号的全集**。

## 本脚本做什么

    ① 从 server/src/server.ts 抽门符号（`can*` / `require*` / `*Denied` / `assert*` 的调用点）
    ② 每条写路由（方法 ∈ PUT/POST/PATCH/DELETE，或 method=None 但登记为多方法含写）
       解析它的 if 块，收集块内的门符号
    ③ 三态判定：有门 / 按设计公开（名单 + 理由）/ **判不了**
    ④ 反向断言：KNOWN_GATES 里每个符号必须至少在一条写路由块里出现 —— 否则是**登记在腐化**
       （门改名后保留旧名 ⇒ 未来的扫描会安静地少一个符号）

## 退出码

    0 = 每条写路由都有门或已在公开名单里，且没有腐化的登记
    1 = 有 WRITE_ROUTE_UNGATED / GATE_SYMBOL_UNUSED / PUBLIC_ENTRY_STALE
    2 = 没有读数（读不到表或源码）

用法：python3 scripts/report-rest-gates.py [--assert] [--selftest]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TABLE = REPO / "docs" / "rest-route-table.json"
SOURCE = REPO / "server" / "src" / "server.ts"

WRITE_METHODS = ("PUT", "POST", "PATCH", "DELETE")

# 门符号的形态。**宽进**：宁可多认一个再去登记，也不要因为「它看起来不像门」而漏掉。
GATE_RE = re.compile(r"\b((?:can|require|assert)[A-Z]\w*|\w+Denied)\s*\(")

# 2026-11-01 —— 从源码**抽出来**的门符号（`can*` / `require*` / `*Denied` / `assert*` 的调用点）。
#
# 这张表不是「我认为有哪些门」，而是「抽取器今天在路由块里看到的全部」：
# 抽取结果与它**逐字相等**才算过（多一个 ⇒ UNLISTED，少一个 ⇒ UNUSED）。
# 上一轮那个洞正是「表没跟上，而扫描照样给出一个数」—— 于是用相等性代替「包含」。
KNOWN_GATES = {
    "assertNodeActive", "assertNodeHealthy",
    "canManageGroup", "canMessageAgent", "canRestWriteNetwork",
    "canRestWriteNetworkAsHuman", "canRestWriteNodeSecurity", "canSetPermissionMode",
    "requireAuth", "requireTmuxAccess",
    "restNodeDenied", "restrictedMemberAttachmentsDenied", "scopeDenied",
}

# 名字不带前缀的老门 / 已解析身份。它们**不参与**与抽取集的相等性，
# 只要求「这个名字还在 server.ts 里」—— 改名之后旧名会留着，而扫描会安静地少认一个符号。
EXTRA_GATE_NAMES = {
    "resolveToken", "isNodeCredential", "userTokenRequired", "isAdmin",
    # `#3346` 实测：`POST /api/dm` 与 `POST /api/messages/ack` 的门写成
    #     const callerUserId = restAuth?.userId ?? null;  if (!callerUserId) return 401;
    # 形态扫描看不见它们 ⇒ 一度被我判成「无门」。有身份的读者才知道它们有门。
    "restAuth", "restScope", "callerUserId",
}

# 按设计公开的写路由：**必须带理由**。它们是「无门」的合法解释，而不是漏掉的清单。
PUBLIC_BY_DESIGN = {
    ("/api/auth/register", "POST"): "新用户注册，本来就无身份；靠 IP 限流 + 口令强度兜底",
    ("/api/auth/login", "POST"): "登录，本来就无身份；靠 IP 限流 + 锁定计数兜底",
}


def source_lines() -> list[str]:
    return SOURCE.read_text(encoding="utf-8", errors="replace").splitlines()


def if_block(lines: list[str], row_line: int) -> tuple[int, list[str]] | None:
    """行的 1-based 行号 ⇒ (if 行下标, 块内各行)。找不到 if 就返回 None。"""
    start = row_line - 1
    for k in range(start, min(start + 4, len(lines))):
        if re.match(r"\s*if\s*\(", lines[k]):
            depth = 0
            out = []
            for j in range(k, min(k + 400, len(lines))):
                out.append(lines[j])
                depth += lines[j].count("{") - lines[j].count("}")
                if depth == 0 and j > k:
                    break
            return k, out
    return None


DENY_RE = re.compile(r"\b(return|throw)\b|40[13]|denied|forbid", re.I)


def guard_position_lines(block: list[str]) -> set[int]:
    """块内「门**真的被用来拒绝**」的那些行下标。

    2026-11-01 —— 上一版只问「块里出现过这个符号」。那是**入口层**证据：
    `console.log(canRestWriteNetwork(...))` 也满足它，而它一点也没拦住谁。
    （外部复核的判别法：把那个调用挪到不拦截的位置，断言仍绿 ⇒ 只到入口层。）

    这里换成两条守卫形态，都是可判的：
      · `if (<含门符号>)` 且 1–2 行内出现拒绝词（return / throw / 401 / 403 / denied）
      · `const denied = <门>()` 之后 3 行内出现引用它的 `if (…)`
    """
    out: set[int] = set()
    for i, line in enumerate(block):
        if re.match(r"\s*if\s*\(", line):
            window = " ".join(block[i:i + 3])
            if DENY_RE.search(window):
                out.add(i)
    for i, line in enumerate(block):
        m = re.match(r"\s*(?:const|let)\s+(\w+)\s*=", line)
        if not m:
            continue
        name = m.group(1)
        for j in range(i + 1, min(i + 4, len(block))):
            if re.match(r"\s*if\s*\(", block[j]) and name in block[j]:
                out.add(i)
                break
    return out


def write_routes(doc: dict) -> list[dict]:
    rows = [r for r in (doc.get("rows") or []) if (r.get("method") or "") in WRITE_METHODS]
    for m in ((doc.get("method_parse") or {}).get("multi_method") or []):
        if any(x in WRITE_METHODS for x in (m.get("methods") or ())):
            rows.append({"path": m.get("path"), "line": m.get("line"),
                         "method": "+".join(m.get("methods") or [])})
    return rows


def symbols_in(block: list[str]) -> tuple[set[str], set[str]]:
    """(块内的门符号, 块内「形态认得但清单没登记」的符号)。"""
    text = "\n".join(block)
    by_pattern = set(GATE_RE.findall(text))
    by_name = {g for g in EXTRA_GATE_NAMES if re.search(rf"\b{re.escape(g)}\b", text)}
    return by_pattern | by_name, by_pattern - KNOWN_GATES


def classify(doc: dict, lines: list[str]) -> dict:
    gated, public, unknown, unlisted = [], [], [], set()
    # 全路由（读+写）用到的符号：用来判「登记在腐化」。
    # 只在写路由块里找会把「只守读路由的门」误判成已死 —— 那会给出一条假的清理建议。
    all_used: set[str] = set()
    for r in (doc.get("rows") or []):
        found = if_block(lines, int(r.get("line") or 0))
        if found:
            syms, extra = symbols_in(found[1])
            all_used |= syms
            unlisted |= extra
    for r in write_routes(doc):
        found = if_block(lines, int(r.get("line") or 0))
        path = str(r.get("path"))
        if found is None:
            unknown.append((path, r.get("method"), r.get("line"), "找不到 if 块"))
            continue
        _, block = found
        # 两种识别同时开（理由见 symbols_in）：
        #   ① 形态（can*/require*/*Denied/assert*）—— 发现清单里还没有的新门
        #   ② 已登记名字的存在性       —— 覆盖 resolveToken / restAuth / callerUserId 这类
        # 只开 ① 会重演那个假阴性：第一版脚本报「19 条写路由无门」，而它们全都调了 resolveToken。
        syms, _extra = symbols_in(block)
        guard_idx = guard_position_lines(block)
        guard_syms = sorted({s for i in guard_idx for s in symbols_in([block[i]])[0]})
        syms = sorted(syms)
        if guard_syms:
            gated.append((path, r.get("method"), guard_syms))
        elif syms:
            # 块里有门符号，但不在守卫位置 ⇒ 入口层证据，不算有门。
            unknown.append((path, r.get("method"), r.get("line"),
                            f"块里有门符号 {syms[:3]}，但没有一处处在守卫位置（if+拒绝 / 赋值后被 if 检查）"))
        elif (path, str(r.get("method"))) in PUBLIC_BY_DESIGN:
            public.append((path, r.get("method")))
        else:
            unknown.append((path, r.get("method"), r.get("line"), "块内没有任何门符号"))
    return {"gated": gated, "public": public, "unknown": unknown,
            "used": all_used, "unlisted": unlisted,
            "extracted": all_used & (set(GATE_RE.findall("\n".join(lines))) or set()),
            "source_text": "\n".join(lines)}


def problems_for(result: dict, doc: dict) -> list[str]:
    out: list[str] = []
    for path, method, line, why in result["unknown"]:
        out.append(f"WRITE_ROUTE_UNGATED: {method} {path}（行 {line}）—— {why}"
                   f"；要么加门，要么把它连同理由加进 PUBLIC_BY_DESIGN")
    extracted = result.get("extracted") or set()
    missing = sorted(KNOWN_GATES - extracted)
    if missing:
        out.append(f"GATE_SYMBOL_UNUSED: {len(missing)} 个已登记的符号在源码里抽不到了"
                   f"（{', '.join(missing[:5])}）—— 门改名后旧名会留在表里，"
                   f"下一次扫描就少认一个符号，而报表看不出来")
    extra = sorted(extracted - KNOWN_GATES)
    if extra:
        out.append(f"GATE_SYMBOL_UNLISTED: {len(extra)} 个源码里的门符号不在清单里"
                   f"（{', '.join(extra[:5])}）—— 新门不加进清单，它就会在别处被漏掉")
    gone = sorted(n for n in EXTRA_GATE_NAMES if not result.get("source_text") or
                  not re.search(rf"\b{re.escape(n)}\b", result.get("source_text") or ""))
    if gone:
        out.append(f"EXTRA_GATE_GONE: {len(gone)} 个带名字的门在 server.ts 里找不到了"
                   f"（{', '.join(gone[:5])}）—— 清单在描述一个不存在的符号")
    have = {(str(r.get('path')), str(r.get('method'))) for r in (doc.get('rows') or [])}
    stale = [k for k in PUBLIC_BY_DESIGN if k not in have]
    if stale:
        out.append(f"PUBLIC_ENTRY_STALE: 公开名单里 {len(stale)} 条已不在表里（{stale[:3]}）"
                   f" —— 名单在腐化，「公开」这个理由会套在别的路由上")
    return out


def selftest() -> int:
    """合成输入，钉住三件事：有门算有门 / 无门且未登记要报 / 登记腐化要报。"""
    fails = 0
    doc = {"rows": [
        {"path": "/w/gated", "method": "PUT", "line": 2},
        {"path": "/w/bare", "method": "POST", "line": 5},
        {"path": "/api/auth/login", "method": "POST", "line": 8},
    ]}
    lines = [
        "",
        "if (m && req.method === \"PUT\") {",
        "  if (!canRestWriteNetwork(a)) return 403;",
        "}",
        "",
        "if (m && req.method === \"POST\") {",
        "  return ok();",
        "}",
        "",
        "if (url.pathname === \"/api/auth/login\") {",
        "  return login();",
        "}",
    ]
    res = classify(doc, lines)
    ok = [p for p, _, _ in res["gated"]] == ["/w/gated"]
    print(("✓" if ok else "✗") + " selftest 有门的写路由被算作 gated")
    fails += 0 if ok else 1

    probs = problems_for(res, doc)
    ok = any(x.startswith("WRITE_ROUTE_UNGATED") and "/w/bare" in x for x in probs)
    print(("✓" if ok else "✗") + " selftest 无门且未登记 ⇒ WRITE_ROUTE_UNGATED 点名那条")
    fails += 0 if ok else 1

    ok = not any("/api/auth/login" in x for x in probs)
    print(("✓" if ok else "✗") + " selftest 公开名单里的那条不算缺口")
    fails += 0 if ok else 1

    stale_doc = {"rows": [{"path": "/w/gated", "method": "PUT", "line": 2}]}
    ok = any(x.startswith("PUBLIC_ENTRY_STALE") for x in problems_for(res, stale_doc))
    print(("✓" if ok else "✗") + " selftest 公开名单里的路由消失 ⇒ PUBLIC_ENTRY_STALE")
    fails += 0 if ok else 1

    ok = any(x.startswith("GATE_SYMBOL_UNUSED") for x in probs)
    print(("✓" if ok else "✗") + " selftest 登记了却抽不到 ⇒ GATE_SYMBOL_UNUSED")
    fails += 0 if ok else 1

    # 2026-11-01 —— 入口层 vs 守卫层：符号出现在块里但没拦住任何人 ⇒ 不算有门。
    weak = ["", "if (m) {", "  console.log(canRestWriteNetwork(a));", "  return ok();", "}"]
    res_weak = classify({"rows": [{"path": "/w/weak", "method": "PUT", "line": 2}]}, weak)
    ok = len(res_weak["gated"]) == 0 and len(res_weak["unknown"]) == 1
    print(("✓" if ok else "✗") + " selftest 块里有门符号但不在守卫位置 ⇒ 判不了（不是有门）")
    fails += 0 if ok else 1
    return 0 if fails == 0 else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if not TABLE.exists() or not SOURCE.exists():
        print(f"✗ 读不到 {TABLE.name} 或 server.ts ⇒ 没有读数", file=sys.stderr)
        return 2
    doc = json.loads(TABLE.read_text(encoding="utf-8"))
    result = classify(doc, source_lines())
    total = len(result["gated"]) + len(result["public"]) + len(result["unknown"])
    print(f"写路由 {total}：有门 {len(result['gated'])} · 按设计公开 {len(result['public'])} "
          f"· 判不了 {len(result['unknown'])}")
    print("  门的判据：**守卫位置**（if+拒绝词 / 赋值后被 if 检查），不是「块里出现过」")
    if result["unlisted"]:
        print(f"  ⚠ 源码里有、但清单里没有的门符号 {len(result['unlisted'])} 个："
              f"{', '.join(sorted(result['unlisted']))[:160]}")
        print("    （不单独判红：它们可能只用于读路由。但出现在写路由块里时会在下面被点名）")
    for path, method in result["public"]:
        print(f"  公开 {method} {path} —— {PUBLIC_BY_DESIGN[(path, method)]}")
    probs = problems_for(result, doc)
    for x in probs:
        print(f"✗ {x}", file=sys.stderr)
    print("  mutates: none（只读）")
    if probs:
        return 1 if "--assert" in sys.argv else 0
    print("✓ 每条写路由都能说出它的门（或说出它为什么不需要）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
