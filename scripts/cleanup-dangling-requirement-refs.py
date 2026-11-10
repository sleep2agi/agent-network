#!/usr/bin/env python3
"""一次性清理：指向已不存在节点的卡引用（#3277 的「存量」那一半）。

背景（实测，2026-10-31）：
    生产库 requirements（archived=0）3256 张；owner/agent_owner/participant 引用 3165 个；
    其中 **31 个**指向已不存在的对象（归并后只有 **3 个 node id**）。
    其中两个 id 在 api_tokens 里仍有绑定行、nodes 表已无该行
    ⇒ 悬空来自「删节点没有清引用」的旧路径（`.243` 已修，只保证不再增长）。

本脚本只处理**存量**：
    · agent_owner 指向不存在的 node ⇒ 置空
    · participants 含不存在的 node    ⇒ 摘掉
    · owner 指向不存在的 user         ⇒ **不动**（人的删除策略与节点不同，需人工判定）
用法：
    python3 scripts/cleanup-dangling-requirement-refs.py --db ~/.commhub/commhub.db            # dry-run
    python3 scripts/cleanup-dangling-requirement-refs.py --db … --apply                        # 真写
退出码：0 有读数（dry-run 也返回 0）｜ 2 打不开库。

⚠️ 默认 dry-run。--apply 会**直接改库**：先停 hub 或确认无并发写，并确保有备份。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/.commhub/commhub.db"))
    ap.add_argument("--apply", action="store_true", help="真的写库（默认只打印）")
    args = ap.parse_args(argv)

    path = Path(args.db).expanduser()
    if not path.is_file():
        print(f"✗ 找不到库：{path}", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{path}?mode={'rw' if args.apply else 'ro'}", uri=True)
    cur = con.cursor()
    nodes = {r[0] for r in cur.execute("select node_id from nodes")}
    users = {r[0] for r in cur.execute("select user_id from users")}

    rows = cur.execute(
        "select requirement_id, seq, agent_owner_json, participants_json from requirements where archived=0"
    ).fetchall()

    clear_owner: list[tuple[str, str]] = []      # (requirement_id, node_id)
    strip_parts: list[tuple[str, str]] = []      # (requirement_id, node_id)
    user_orphans: list[tuple[int, str]] = []

    for rid, seq, aj, pj in rows:
        if aj and aj not in ("null", ""):
            try:
                d = json.loads(aj)
            except Exception:
                d = None
            if d and d.get("kind") == "node" and d.get("id") and d["id"] not in nodes:
                clear_owner.append((rid, d["id"]))
        if pj and pj not in ("null", ""):
            try:
                lst = json.loads(pj) or []
            except Exception:
                lst = []
            for ref in lst:
                if isinstance(ref, dict) and ref.get("kind") == "node" and ref.get("id") and ref["id"] not in nodes:
                    strip_parts.append((rid, ref["id"]))
                if isinstance(ref, dict) and ref.get("kind") == "user" and ref.get("id") and ref["id"] not in users:
                    user_orphans.append((seq, ref["id"]))
        # owner 的悬空只统计，不处理
        if aj is None:
            pass
    # owner 悬空（独立扫描，避免上面分支耦合）
    for rid, seq, oj in cur.execute(
        "select requirement_id, seq, owner_json from requirements where archived=0 and owner_json is not null"
    ).fetchall():
        try:
            d = json.loads(oj)
        except Exception:
            continue
        if d and d.get("kind") == "user" and d.get("id") and d["id"] not in users:
            user_orphans.append((seq, d["id"]))

    print(f"库：{path}")
    print(f"agent_owner 指向不存在节点：{len(clear_owner)} 张")
    print(f"participants 含不存在节点  ：{len(strip_parts)} 处")
    print(f"指向不存在**用户**的引用    ：{len(user_orphans)} 处（**本脚本不动**，需人工判定）")

    if not args.apply:
        print("dry-run：未写库。加 --apply 才会改（建议先备份）。")
        return 0

    changed = 0
    for rid, nid in clear_owner:
        cur.execute(
            "update requirements set agent_owner_json = null, updated_at = ? where requirement_id = ?",
            (__import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z", rid),
        )
        changed += cur.rowcount
    for rid, nid in {tuple(x) for x in strip_parts}:
        row = cur.execute("select participants_json from requirements where requirement_id = ?", (rid,)).fetchone()
        try:
            lst = json.loads(row[0] or "[]") if row else []
        except Exception:
            continue
        nxt = [r for r in lst if not (isinstance(r, dict) and r.get("kind") == "node" and r.get("id") == nid)]
        if len(nxt) != len(lst):
            cur.execute("update requirements set participants_json = ? where requirement_id = ?",
                        (json.dumps(nxt, ensure_ascii=False), rid))
            changed += cur.rowcount
    con.commit()
    print(f"已提交：影响 {changed} 行。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
