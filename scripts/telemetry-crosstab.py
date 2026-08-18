#!/usr/bin/env python3
"""一个字段是空的 —— 是这个节点坏了,还是这一类节点根本不上报?

🔴 为什么需要它(2026-08-18 实例,见 #832 / #914):

  有人来查一个节点「收到任务没做」还是「根本没收到」,要「最近一次真正消费任务
  的时间」。`get_all_status` 里名字**正好对上**的三个字段
  (process_in_flight_count / process_uptime_seconds / process_cpu_pct)
  对那个节点**全是 None**。

  如果就这么读,结论是「它死了」—— 而这类结论的下一步动作通常是**重启一个健康
  节点**。真正救回判断的是一次**横向对照**:同机另外两个节点也全是 None,
  ⇒ 不是节点坏了,是**这个 agent 类型压根不上报**。

  那次对照是人临时想到的,不是任何工具给的。这个脚本就是把它固化下来。

## 判据

对每个遥测字段,把「本节点」放进它的**同类群体**里看,给出三种互不相同的判定:

    有值            本节点这个字段有值 —— 直接可读
    未上报(整类空)   本节点空,而**同类里没有任何一个有值** ⇒ 该类型不上报这一项,
                    空值不含信息,**不要据此下结论**
    🔴 本节点独空    本节点空,而**同类里有别的节点有值** ⇒ 这才是值得查的信号

「同类」默认取两个维度:同 `hostname`、同 `agent`。两个维度都算,因为它们
会给出不同的答案(同机可能混跑多种 agent;同 agent 可能散在多台机上)。

## 用法

    anet ... > snapshot.json          # 任何 {"sessions":[...]} 形状的快照
    python3 scripts/telemetry-crosstab.py snapshot.json <alias>
    python3 scripts/telemetry-crosstab.py --selftest

🔴 不联网、不带凭据、不打印 task/output 正文 —— 它只看遥测字段,
   避免把别人的工作内容顺手打印出来。
"""
from __future__ import annotations

import json
import sys

# 只看这些;刻意不含 task / output / config —— 那些是内容,不是遥测。
FIELDS = [
    "process_in_flight_count", "process_uptime_seconds", "process_cpu_pct",
    "process_rss_mb", "cpu_load_1min", "mem_used_gb", "disk_used_gb",
    "version", "model", "node_id", "session_id", "external_schedules",
    "peer_reply_inbox_capable",
]

VERDICT_HAS = "有值"
VERDICT_TYPE_BLIND = "未上报(整类空)"
VERDICT_ONLY_THIS = "🔴 本节点独空"


def is_empty(v) -> bool:
    return v is None or v == "" or v == {} or v == []


def classify(target: dict, peers: list[dict], field: str) -> str:
    if not is_empty(target.get(field)):
        return VERDICT_HAS
    if any(not is_empty(p.get(field)) for p in peers):
        return VERDICT_ONLY_THIS
    return VERDICT_TYPE_BLIND


def report(sessions: list[dict], alias: str, out=sys.stdout) -> int:
    target = next((s for s in sessions if s.get("alias") == alias), None)
    if target is None:
        print(f"FAIL: 快照里没有 alias={alias!r}", file=sys.stderr)
        return 2

    groups = {
        f"同机 hostname={target.get('hostname')!r}":
            [s for s in sessions if s is not target and s.get("hostname") == target.get("hostname")],
        f"同类 agent={target.get('agent')!r}":
            [s for s in sessions if s is not target and s.get("agent") == target.get("agent")],
    }

    print(f"alias={alias}  hostname={target.get('hostname')}  agent={target.get('agent')}", file=out)
    for label, peers in groups.items():
        print(f"\n== {label}  （{len(peers)} 个同类）==", file=out)
        if not peers:
            # 🔴 分母承重:没有同类时,任何「整类空」的判定都是无意义的。
            print("  ⚠ 没有同类可比 —— 这一组不给判定（空值在这里无法解读）", file=out)
            continue
        for f in FIELDS:
            v = target.get(f)
            print(f"  {f:<26} {str(v)[:22]:<24} {classify(target, peers, f)}", file=out)

    # 🔴 两个分组给出**相反判定**时,必须喊出来。
    #
    #    实测(2026-08-18,TM宿舍马):
    #      同机 hostname=vanisn  → process_* 判「本节点独空」
    #      同类 agent=claude-code → process_* 判「未上报(整类空)」
    #
    #    只看前者会得出「这台机上别人都在报,就它不报 ⇒ 它有问题」——**错的**。
    #    真相是这台机上混跑了别的 agent 类型,而那一类会报。
    #
    #    这两个轴回答的**不是同一个问题**:
    #      同类 agent → 「这个软件报不报这一项」        ← 判「空值有没有信息」用这个
    #      同机 host  → 「这台机的采集是不是坏了」      ← 判「机器侧异常」用这个
    #    所以不合并成一个结论,而是把分歧摆出来并说明该看哪一个。
    disagree = []
    named = list(groups.items())
    for f in FIELDS:
        vs = {label: classify(target, peers, f) for label, peers in named if peers}
        if len(set(vs.values())) > 1:
            disagree.append((f, vs))

    print(f"\n判定完 {len(FIELDS)} 个字段。", file=out)
    print("🔴 «未上报(整类空)» 的字段不含信息 —— 不要据此判断节点死活。", file=out)

    if disagree:
        print(f"\n🔴 有 {len(disagree)} 个字段在两个分组上判定相反 —— 这不是 bug,是它们在回答不同的问题:", file=out)
        print("     同类 agent → 「这个软件报不报这一项」  ← 判「空值有没有信息」看这个", file=out)
        print("     同机 host  → 「这台机的采集是不是坏了」← 判「机器侧异常」看这个", file=out)
        for f, vs in disagree:
            detail = "  |  ".join(f"{lbl.split()[0]}:{v}" for lbl, v in vs.items())
            print(f"     {f:<26} {detail}", file=out)
        print("   ⇒ 一台机上混跑多种 agent 时,「同机」几乎必然给出「本节点独空」。**别拿它当结论。**", file=out)
    return 0


def selftest() -> int:
    S = [
        {"alias": "A", "hostname": "h1", "agent": "claude-code", "process_cpu_pct": None, "version": None},
        {"alias": "B", "hostname": "h1", "agent": "claude-code", "process_cpu_pct": None, "version": "1.0"},
        {"alias": "C", "hostname": "h2", "agent": "codex",       "process_cpu_pct": 12.5, "version": "2.0"},
    ]
    A, B, C = S
    cases = []

    def ck(name, got, want):
        cases.append((name, got == want, f"got={got} want={want}"))

    ck("同类都空 → 未上报(整类空)", classify(A, [B], "process_cpu_pct"), VERDICT_TYPE_BLIND)
    ck("同类有值而本节点空 → 独空", classify(A, [B], "version"), VERDICT_ONLY_THIS)
    ck("本节点有值 → 有值",       classify(C, [A, B], "process_cpu_pct"), VERDICT_HAS)
    # 🔴 空的几种写法都要算空,否则 "" / {} / [] 会被当成「有值」而给出假的「独空」
    for empty in ("", {}, []):
        ck(f"空值写法 {empty!r} 视为空",
           classify({"x": empty}, [{"x": empty}], "x"), VERDICT_TYPE_BLIND)
    ck("0 不是空（0 是一个真实读数）",
       classify({"x": 0}, [{"x": None}], "x"), VERDICT_HAS)
    ck("False 不是空", classify({"x": False}, [{"x": None}], "x"), VERDICT_HAS)

    for n, ok, d in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}   [{d}]")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if len(sys.argv) < 3:
        print(__doc__.strip().split("## 用法")[1].strip(), file=sys.stderr)
        return 2
    raw = json.load(open(sys.argv[1], encoding="utf-8"))
    sessions = raw.get("sessions") if isinstance(raw, dict) else raw
    if not sessions:
        print("FAIL: 快照里 sessions 为空 —— 拒绝在空分母上给判定", file=sys.stderr)
        return 2
    return report(sessions, sys.argv[2])


if __name__ == "__main__":
    sys.exit(main())
