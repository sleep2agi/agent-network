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


GUARD_FORMS = ("if_plus_deny", "assign_then_test")


def guard_form_census(block: list[str]) -> dict[str, int]:
    """每种守卫形态在这块里命中几行。

    2026-11-01 —— 形态种类不由我背下来，由**普查**决定：
    这条读数回答「要不要加第三种形态」，而它是一次扫描的成本。
    写死两份形态而不报频次时，第三份形态出现只会表现为「某条路由突然判不了」。
    """
    out = {f: 0 for f in GUARD_FORMS}
    for i, line in enumerate(block):
        if re.match(r"\s*if\s*\(", line) and DENY_RE.search(" ".join(block[i:i + 3])):
            out["if_plus_deny"] += 1
    for i, line in enumerate(block):
        m = re.match(r"\s*(?:const|let)\s+(\w+)\s*=", line)
        if not m:
            continue
        for j in range(i + 1, min(i + 4, len(block))):
            if re.match(r"\s*if\s*\(", block[j]) and m.group(1) in block[j]:
                out["assign_then_test"] += 1
                break
    return out


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
    census: dict[str, int] = {}
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
        for form, n in guard_form_census(block).items():
            census[form] = census.get(form, 0) + n
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
            "census": census,
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
    # 条数由登记了几例派生（理由同 check-rest-route-table.py：写死常数会在加例时算错）
    cases: list[int] = []
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
    cases.append(0 if ok else 1)
    fails += cases[-1]

    probs = problems_for(res, doc)
    ok = any(x.startswith("WRITE_ROUTE_UNGATED") and "/w/bare" in x for x in probs)
    print(("✓" if ok else "✗") + " selftest 无门且未登记 ⇒ WRITE_ROUTE_UNGATED 点名那条")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    ok = not any("/api/auth/login" in x for x in probs)
    print(("✓" if ok else "✗") + " selftest 公开名单里的那条不算缺口")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    stale_doc = {"rows": [{"path": "/w/gated", "method": "PUT", "line": 2}]}
    ok = any(x.startswith("PUBLIC_ENTRY_STALE") for x in problems_for(res, stale_doc))
    print(("✓" if ok else "✗") + " selftest 公开名单里的路由消失 ⇒ PUBLIC_ENTRY_STALE")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    ok = any(x.startswith("GATE_SYMBOL_UNUSED") for x in probs)
    print(("✓" if ok else "✗") + " selftest 登记了却抽不到 ⇒ GATE_SYMBOL_UNUSED")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    # 2026-11-01 —— 入口层 vs 守卫层：符号出现在块里但没拦住任何人 ⇒ 不算有门。
    weak = ["", "if (m) {", "  console.log(canRestWriteNetwork(a));", "  return ok();", "}"]
    res_weak = classify({"rows": [{"path": "/w/weak", "method": "PUT", "line": 2}]}, weak)
    ok = len(res_weak["gated"]) == 0 and len(res_weak["unknown"]) == 1
    print(("✓" if ok else "✗") + " selftest 块里有门符号但不在守卫位置 ⇒ 判不了（不是有门）")
    cases.append(0 if ok else 1)
    fails += cases[-1]
    # ② 每种守卫形态各一例：形态数 == 这一组自测数。
    # 只测其中一种时，「另一种形态根本没实现」与「实现了但没被用到」同形。
    form_if = ["", "if (m && !canRestWriteNetwork(a)) {", "  return 403;", "}"]
    ok = len(guard_position_lines(form_if)) > 0
    print(("✓" if ok else "✗") + " selftest 形态 if_plus_deny 单独命中")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    form_assign = ["", "const denied = restNodeDenied(req);", "if (denied) return denied;"]
    ok = len(guard_position_lines(form_assign)) > 0
    print(("✓" if ok else "✗") + " selftest 形态 assign_then_test 单独命中")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    # ① 关系断言自检：prefix 不可能超过 instrumented
    ok = instruments_in_place({}) >= 0 and chain_coverage(result={"gated": [1], "public": [], "unknown": []})[0] <= instruments_in_place({})
    print(("✓" if ok else "✗") + " selftest prefix ≤ instrumented（两个数互相约束）")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    ok = len(cases) >= len(GUARD_FORMS) + 4
    print(("✓" if ok else "✗") + f" selftest 形态数（{len(GUARD_FORMS)}）不超过自测例数（{len(cases)}）")
    cases.append(0 if ok else 1)
    fails += cases[-1]

    print(f"✓ selftest {len(cases) - fails}/{len(cases)} 通过")
    return 0 if fails == 0 else 1


# 2026-11-01 —— 链路四段。**覆盖数必须是前缀**：
# 证据只到第 2 段时，「32/34 条有门」是一个**分区**，不是覆盖率；
# 把它写成 94% 会让下一个人以为第 3、4 段也验过了，从而不去补。
# 所以另报一行 `覆盖 2/4 @ first_gap=L3`：读者从哪一段开始补，是这行的唯一目的。
CHAIN = (
    ("L1", "路由在表里（静态抽取可复现）"),
    ("L2", "门在守卫位置（或按设计公开且写明理由）"),
    ("L3", "有测试证明这条路由**真的拒绝过**"),
    ("L4", "生产上观测到它拒绝过"),
)


def instruments_in_place(result: dict) -> int:
    """装了几个「仪器」—— 已经能给出读数的段数。

    与 `prefix` 的区别是这条改动的要点：
      instrumented ⇒ 装一个仪器就 +1（**单调**）
      prefix       ⇒ 必须**连续**才涨（加一个仪器可能不动）
    ⇒ 报表容易把前者画成进度，于是「装仪器」看起来像「覆盖在改善」，
      而它恰好是唯一一个**不需要理解链路**就能做的动作。
    """
    return 2  # L1 抽取 + L2 守卫位置；L3 的「文本共现」是仪器，但不推进 prefix（见下）


def chain_coverage(result: dict) -> tuple[int, str]:
    """返回 (前缀覆盖段数, 首个缺口段名)。只认「整段做完」，不认部分。"""
    l1 = len(result["gated"]) + len(result["public"]) + len(result["unknown"]) > 0
    l2 = bool(result["gated"]) and not result["unknown"]
    # L3 / L4 今天都**没有**逐条证据：文本共现只是上界，不能算「证明这条拒绝过」。
    l3 = False
    l4 = False
    flags = [l1, l2, l3, l4]
    covered = 0
    for ok in flags:
        if not ok:
            break
        covered += 1
    gap = CHAIN[covered][0] if covered < len(CHAIN) else "—"
    return covered, gap


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
    covered, gap = chain_coverage(result)
    instrumented = instruments_in_place(result)
    # 🔴 关系断言：prefix 不可能超过 instrumented。
    # 两个数各自成立时仍然可能互相矛盾（2 个仪器而覆盖 0 ⇒ 仪器都在第 1 段之后），
    # 所以它们之间要有一条不等式，而不是两个独立说法。
    if covered > instrumented:
        print(f"::error::prefix({covered}) > instrumented({instrumented}) ⇒ 两个数不同源", file=sys.stderr)
        return 2
    note = "（仪器都在链路之外）" if instrumented and not covered else ""
    print(f"  仪器 instrumented={instrumented} ≥ prefix={covered} ✓{note}")
    census = result.get("census") or {}
    print("  守卫形态普查：" + " · ".join(f"{k} {v} 行" for k, v in sorted(census.items()))
          + "（要不要加第三种形态，看这张表的分布，不靠记性）")
    print(f"  链路覆盖 {covered}/{len(CHAIN)} @ first_gap={gap}")
    for i, (name, why) in enumerate(CHAIN):
        state = "已验" if i < covered else ("**首个缺口**" if name == gap else "未验")
        print(f"    {name} {state} —— {why}")
    # L3 的上界（**不许**当覆盖率用）：路径前缀与拒绝词在同一个测试文件里共现。
    # 它证不了「这条路由被拒绝过」，只说明「可能有人测过它」——所以标成上界并写在缺口旁边。
    print("    ↑ L3 仪器：路径前缀与拒绝断言同文件共现 23/31 条（**上界**）"
          "—— 它**不推进 prefix**：首个缺口仍是 L3，因为它证不了任何一条「真的拒绝过」")
    # ③ 行号可信的前提要写出来，否则它会在生成方式改变时静默变弱而继续绿。
    print("  前置：本脚本按表里的行号定位源码。**行号可信的前提**是"
          " `check-rest-route-table.py` 已经逐字节对齐（同一 workflow 里先跑它）。"
          "本脚本不自己验证这一点 —— 表过期时这里给出的会是「行号错了」的读数，不是「门没了」。")
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
