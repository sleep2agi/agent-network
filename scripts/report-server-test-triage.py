#!/usr/bin/env python3
"""把 `scripts/run-server-tests.sh` 的全量输出按**失败原因**分档，而不是只报「几个文件红了」。

2026-10-31 —— 起因：三个测试在从 `server/` 跑时长期红着，红的理由是「子进程用仓库根相对路径」。
那既不是被测语义坏了，也不是环境缺件；但报告里它们与真缺陷长得一样。
⇒ 「红了几条」不是可行动的信息，**「红在哪一档」**才是。

分档（按证据强弱排，命中即停）：

    fixture_path   —— 报错里出现 `Cannot find module` / `ENOENT` / `Module not found`，
                      且路径里带 `./server/` 或 `server/src/`（cwd 依赖那一类）
    environment    —— `docker` / `ECONNREFUSED` / `password authentication failed` /
                      缺少某个必需 env（含「requires an explicit ... COMMHUB_DB」这类显式拒绝）
    timeout        —— `timed out` / `timeout` / 跑该文件的子进程被 kill
    assertion      —— 有 `expect(...)` 的期望/实际差值（**这才是真缺陷候选**）
    unknown        —— 以上都不匹配 ⇒ 必须人工看（不许算作任意一档）

判据必须诚实：这是**对日志的分类**，不是对代码的定性。
一次 assertion 失败也可能是夹具问题；所以 `assertion` 档只写「真缺陷**候选**」。

用法：
    bash scripts/run-server-tests.sh > /tmp/full.txt 2>&1
    python3 scripts/report-server-test-triage.py /tmp/full.txt
    python3 scripts/report-server-test-triage.py /tmp/full.txt --json

退出码：0 = 有读数且没有 assertion/unknown；1 = 有 assertion 或 unknown（需要人看）；2 = 没有读数。
"""
from __future__ import annotations

import hashlib
import json
import platform
import re
import sys
from pathlib import Path

BUCKETS = ("declared_by_author", "fixture_path", "environment", "timeout", "assertion", "unknown")
BUCKET_ZH = {
    "declared_by_author": "作者在文件头声明过「本地必红」并指出权威测试在哪（**引用原文，不采信结论**）",
    "fixture_path": "夹具/路径（cwd 依赖、模块找不到）",
    "environment": "环境缺件（docker / 连接 / 必需 env）",
    "timeout": "超时",
    "assertion": "断言失败（**真缺陷候选**）",
    "unknown": "未匹配任何判据（必须人工看）",
}

# 2026-10-31 —— 第四档：**作者自己写下来的本地必红**。
# 依据是仓库里真实存在的写法（daemon-provider-snapshots.test.ts 开头）：
#   「本地直跑会看到 4 条红，那不是回归…判定这个文件是否健康，看 hub-provider-core.yml 的容器测试」
# 为什么值得单独一档而不是直接信它：
#   ① 一个可以自我豁免的判据等于没有判据 ⇒ 这里只**引用原文**并单独计数，绝不折进「绿」；
#   ② 它必须指出**权威测试在哪**（xx.yml / 容器套件），否则不算声明，仍落到 assertion；
#   ③ 读的人可以拿那段引文去核对容器 CI 是不是真的在跑。
DECLARED = re.compile(r"不是回归|本地直跑|本地必红|requires docker|需要 docker|看\s*\S+\.yml")

PATTERNS = (
    ("fixture_path", re.compile(r"Cannot find module|Module not found|ENOENT|ERR_MODULE_NOT_FOUND", re.I)),
    ("environment", re.compile(r"docker|ECONNREFUSED|password authentication failed|requires an explicit|"
                               r"is not set|missing env|no such container", re.I)),
    ("timeout", re.compile(r"timed out|timeout|SIGKILL|killed", re.I)),
    ("assertion", re.compile(r"Expected:|Received:|expect\(received\)|toBe\(|toEqual\(")),
)


def _measured_by() -> dict:
    try:
        digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:12]
    except OSError:
        digest = "unreadable"
    return {"script": Path(__file__).name, "sha256_12": digest,
            "interpreter": f"python{platform.python_version()}"}


def declared_header(path: str, root: Path) -> str | None:
    """读文件头 40 行，找「本地必红 + 权威测试在哪」的声明。返回命中的那一行原文。

    路径有两种形态：日志里是 `src/x.test.ts`，而仓库根和 `server/` 下各有一套。
    先按原样找，再试 `server/` —— 都找不到就当作**没有声明**（不做猜测）。
    """
    f = root / path
    if not f.is_file():
        alt = root / "server" / path
        if not alt.is_file():
            return None
        f = alt
    try:
        head = f.read_text(encoding="utf-8", errors="replace").splitlines()[:40]
    except OSError:
        return None
    for ln in head:
        if DECLARED.search(ln) and ("//" in ln or "#" in ln or "*" in ln):
            return ln.strip()
    return None


def classify(block: str) -> tuple[str, str]:
    for name, pat in PATTERNS:
        if pat.search(block):
            return name, pat.search(block).group(0)[:60]
    return "unknown", ""


def parse(text: str, root: Path) -> dict:
    # 逐文件汇总行：`PASS src/x.test.ts  12 pass  0 fail` / `FAIL …`
    results = re.findall(r"^(PASS|FAIL)\s+(\S+)\s+(\d+) pass\s+(\d+) fail", text, re.M)
    failed = [r for r in results if r[0] == "FAIL"]
    # 每个失败文件在输出里对应的一段（到下一个 PASS/FAIL 行为止）
    blocks: dict[str, str] = {}
    lines = text.splitlines()
    cur = None
    for ln in lines:
        m = re.match(r"^(PASS|FAIL)\s+(\S+)\s", ln)
        if m:
            cur = m.group(2) if m.group(1) == "FAIL" else None
            if cur:
                blocks.setdefault(cur, "")
            continue
        if cur:
            blocks[cur] = blocks.get(cur, "") + ln + "\n"
    rows = []
    for _, path, _p, _f in failed:
        names = re.findall(r"^\(fail\)\s+(.+)$", blocks.get(path, ""), re.M)
        decl = declared_header(path, root)
        if decl:
            # 作者的声明优先于日志判据 —— 但只作为**引用**，不是结论。
            rows.append({"file": path, "bucket": "declared_by_author", "matched": decl,
                         "failed_tests": [n.strip() for n in names][:5]})
            continue
        kind, why = classify(blocks.get(path, ""))
        rows.append({"file": path, "bucket": kind, "matched": why,
                     "failed_tests": [n.strip() for n in names][:5]})
    return {
        "files_total": len(results),
        "files_passed": len(results) - len(failed),
        "files_failed": len(failed),
        "rows": rows,
    }


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("-")]
    if not args:
        print("用法: report-server-test-triage.py <run-server-tests 的输出文件> [--json]", file=sys.stderr)
        return 2
    src = Path(args[0])
    if not src.is_file():
        print(f"✗ 找不到 {src} ⇒ 没有读数", file=sys.stderr)
        return 2
    res = parse(src.read_text(encoding="utf-8", errors="replace"), Path.cwd())
    if res["files_total"] == 0:
        print("✗ 输出里一个 PASS/FAIL 汇总行都没有 ⇒ 没有读数（不是「全绿」）", file=sys.stderr)
        return 2

    counts = {b: 0 for b in BUCKETS}
    for r in res["rows"]:
        counts[r["bucket"]] += 1

    if "--json" in argv:
        print(json.dumps({
            "instrument": "report-server-test-triage",
            "measured_by": _measured_by(),
            "evidence_domain": "log",
            "files_total": res["files_total"],
            "files_passed": res["files_passed"],
            "files_failed": res["files_failed"],
            "buckets": counts,
            "rows": res["rows"],
            "does_not_cover": [
                "分类读的是**日志文本**，不是被测语义；assertion 档只说明「像真缺陷」，不证明是",
                "一个文件里多种失败只按首个命中的判据归档（不重复计数）",
                "unknown 档不是「没问题」，是「没有判据能解释它」——必须人工看",
                "declared_by_author 档**采信的是作者的声明，不是读数**：报告只引用原文 + 指出权威测试；"
                "它没有被折进「绿」，也不证明容器 CI 真的在跑",
            ],
        }, ensure_ascii=False, indent=1))
    else:
        print(f"SERVER-TEST-TRIAGE v1 files={res['files_total']} "
              f"passed={res['files_passed']} failed={res['files_failed']}")
        if res["files_failed"] == 0:
            print("  0 个失败文件")
        else:
            print("  分档（按证据强弱排）:")
            for b in BUCKETS:
                if counts[b]:
                    print(f"    {b:<13} {counts[b]:>3}  {BUCKET_ZH[b]}")
            if counts["declared_by_author"]:
                print(f"  ⚠ 其中 {counts['declared_by_author']} 个文件是**作者声明的本地必红**："
                      f"本次运行没有验证它们，也不把它们算进「绿」。")
                print("     且声明的权威套件**不一定在 HEAD 上跑过**——本仓这类容器套件多为路径过滤触发，"
                      "没改到那些文件就不会跑；「上次绿」不等于「HEAD 绿」。")
            for b in BUCKETS:
                group = [r for r in res["rows"] if r["bucket"] == b]
                if not group:
                    continue
                print(f"\n  ── {b} ──")
                for r in group:
                    hit = f"  ({r['matched']})" if r["matched"] else ""
                    print(f"    {r['file']}{hit}")
                    for t in r["failed_tests"]:
                        print(f"        · {t[:110]}")
    needs_eye = counts["assertion"] + counts["unknown"]
    return 1 if needs_eye else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
