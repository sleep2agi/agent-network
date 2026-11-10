#!/usr/bin/env python3
"""给 qa.yml 的 `hub-orphan-gates` 算出「这次要跑哪些套件」（#2800 / #2136 第二步）。

背景：这个矩阵有 95 个 Docker 套件，而 qa.yml 的 paths 是「命中任一产品路径或 tests/**
就整矩阵」——改两个测试夹具也会拉起 95 个分片。20 个已合并 PR 的回放显示可省 40%，
且没有任何一次「碰了共享面却跳过分片」。

判据**复用** `qa-suite-scope-report.py`（同一份 decide()），本脚本只负责：
  1. 拿到本次改动的文件清单（PR 走 GitHub files API，push 走 HEAD^1 的 diff）；
  2. 调 decide()；
  3. 把 GH Actions 需要的两个 output 写出来。

失败即保守：任何一步出问题都退回「全跑」，绝不因为脚本坏了而少跑证据。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _load_scope():
    import importlib.util
    path = Path(__file__).resolve().parent / "qa-suite-scope-report.py"
    spec = importlib.util.spec_from_file_location("qa_scope", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


scope = _load_scope()

API = "https://api.github.com"
MAX_FILES = 3000  # GitHub 自己的上限；到了就当我们「看不清」→ 全跑


def pr_files(repo: str, number: int, token: str) -> list[str] | None:
    files: list[str] = []
    page = 1
    while page <= 40:
        url = f"{API}/repos/{repo}/pulls/{number}/files?per_page=100&page={page}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "qa-suite-scope-plan",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                batch = json.load(resp)
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            print(f"pr_files: {exc} → fall back to RUN ALL", file=sys.stderr)
            return None
        if not isinstance(batch, list):
            return None
        files += [f["filename"] for f in batch if isinstance(f, dict) and f.get("filename")]
        if len(batch) < 100:
            break
        page += 1
    if len(files) >= MAX_FILES:
        print("pr_files: hit the 3000-file cap → fall back to RUN ALL", file=sys.stderr)
        return None
    return files


def push_files() -> list[str] | None:
    try:
        out = subprocess.run(
            ["git", "diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout
    except subprocess.CalledProcessError as exc:
        print(f"push_files: {exc} → fall back to RUN ALL", file=sys.stderr)
        return None
    return [line.strip() for line in out.splitlines() if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", help="pull_request | push | other")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    ap.add_argument("--pr", default=os.environ.get("PR_NUMBER", ""))
    ap.add_argument("--token", default=os.environ.get("GH_TOKEN", ""))
    ap.add_argument("--output", default=os.environ.get("GITHUB_OUTPUT", ""))
    ap.add_argument("--dry-run", action="store_true", help="print the plan as JSON instead of writing outputs")
    ap.add_argument("--total-only", action="store_true", help="print the matrix size (for the conservative default)")
    args = ap.parse_args()

    suites = scope.suite_list()
    if args.total_only:
        print(len(suites))
        return 0
    if not args.event:
        ap.error("--event is required unless --total-only")
    if not suites:
        print("suite_list() empty → cannot narrow; RUN ALL", file=sys.stderr)
        run, skip = [], []
        changed: list[str] = []
    else:
        changed_files: list[str] | None = None
        if args.event == "pull_request" and args.repo and args.pr and args.token:
            changed_files = pr_files(args.repo, int(args.pr), args.token)
        elif args.event == "push":
            changed_files = push_files()
        # 其它事件（workflow_dispatch 等）：不缩小，全跑
        if changed_files is None:
            run, skip = list(suites), []
            changed = []
        else:
            run, skip, _forced = scope.decide(changed_files, suites)
            changed = changed_files

    plan = {"run": run, "skip": skip, "changed": len(changed), "total": len(suites)}
    if args.dry_run:
        print(json.dumps(plan, ensure_ascii=False))
        return 0

    skip_matrix = [{"suite": s} for s in skip]
    lines = [
        f"suite_count={len(run)}",
        f"suite_total={len(suites)}",
        f"suite_skip={json.dumps(skip_matrix, ensure_ascii=False)}",
    ]
    body = "\n".join(lines) + "\n"
    if args.output:
        with open(args.output, "a", encoding="utf-8") as fh:
            fh.write(body)
    else:
        print(body)
    print(f"suite scope: run {len(run)}/{len(suites)} (changed files {len(changed)})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
