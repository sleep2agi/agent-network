#!/usr/bin/env python3
"""每个 workflow 的每个 job,是不是真的会执行点什么。

## 为什么加这个

合并两个新增 job 的分支时,git 把它们共享的 `runs-on` / `timeout-minutes` /
`steps:` / `- uses: actions/checkout@v4` 判成公共上下文、只保留一份 —— 那几行
逐字相同。按「冲突块取并集」解完之后,产出是这样的:

    doc-source-pins:
      name: doc source-pin floor (Docker)     ← 到此为止
    doc-claims:
      name: doc claim freshness (Docker)
      runs-on: ubuntu-latest
      steps: …（5 个 step 全在这里)

`doc-source-pins` 只剩一行 `name`:没有 `runs-on`、没有 `steps`。

🔴 **这个文件是合法 YAML。** GitHub 接受它,job 名字出现在检查列表里、显示绿色 ——
**一道从不执行的门,和一道执行且通过的门,在 PR 页面上长得一模一样。**

当时仓库里所有的门都是绿的,因为**没有任何一道门检查 workflow 文件本身**
(实测 `.github/` / `scripts/` / `tests/` 里 `yamllint`|`actionlint` 命中 = 0)。
这个脚本就是那道缺失的检查。

## 判据

对 `.github/workflows/*.yml` 的每个 job:

1. 能被 YAML 解析(解析失败直接红);
2. 有非空的 `jobs`;
3. 每个 job **要么**有 `runs-on` + 非空 `steps`,**要么**是 reusable-workflow 调用
   (只有 `uses`)。

第 3 条的两种形态是照现状写的:本仓当前 7 个 workflow、14 个 job **全部**是
`steps` 形态,没有 `uses` 形态 —— 但把 `uses` 也放行,是因为它是 GitHub 的合法
写法,将来有人用了不该被这道门拦住。

## 🔴 它不检查什么

- **不检查 job 会不会通过**,只检查它有没有东西可执行;
- **不检查 step 里的命令对不对**;
- 不做 actionlint 那样的完整校验(未知 `uses`、表达式语法、矩阵展开等都不管)。

**换句话说:它挡的是「这个 job 是个空壳」,不是「这个 job 是对的」。**
真要完整校验,该上 actionlint —— 这个脚本是零依赖的最小兜底,不是它的替代。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("FAIL: 需要 PyYAML（pip install pyyaml / apk add py3-yaml）", file=sys.stderr)
    raise SystemExit(1)

REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
WF_DIR = REPO / ".github" / "workflows"


def main() -> int:
    if not WF_DIR.is_dir():
        print(f"FAIL: 找不到 {WF_DIR}", file=sys.stderr)
        return 1

    files = sorted(list(WF_DIR.glob("*.yml")) + list(WF_DIR.glob("*.yaml")))
    print(f"workflows_scanned={len(files)}")

    # 分母承重:一个 workflow 都没扫到时不能报绿 —— 那多半是目录写错了,
    # 而「0 个文件全过」和「压根没扫到」打印出来是同一片绿。
    if not files:
        print("FAIL: 一个 workflow 都没扫到 —— 检查 WF_DIR 是不是坏了", file=sys.stderr)
        return 1

    total_jobs = 0
    bad = 0
    for path in files:
        rel = path.relative_to(REPO)
        try:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            first = str(exc).splitlines()[0] if str(exc) else "unknown"
            print(f"FAIL: [unparseable] {rel} — {first}", file=sys.stderr)
            bad += 1
            continue

        if not isinstance(doc, dict):
            print(f"FAIL: [not-a-mapping] {rel}", file=sys.stderr)
            bad += 1
            continue

        jobs = doc.get("jobs")
        if not isinstance(jobs, dict) or not jobs:
            print(f"FAIL: [no-jobs] {rel} 没有非空的 jobs", file=sys.stderr)
            bad += 1
            continue

        # 🔴 顶层触发器:没有 on 的 workflow 永远不会跑。独立审查用负向 fixture
        # 实测过:缺 on 的文件在旧版这里直接放行,jobs_checked=1 / problems=0。
        if not (doc.get("on") or doc.get(True)):
            print(f"FAIL: [no-trigger] {rel} 没有顶层 on: —— 这个 workflow 永远不会被触发", file=sys.stderr)
            bad += 1

        for name, job in jobs.items():
            total_jobs += 1
            if not isinstance(job, dict):
                print(f"FAIL: [job-not-a-mapping] {rel} :: {name}", file=sys.stderr)
                bad += 1
                continue
            # reusable workflow 调用:只有 uses,没有 runs-on/steps,是合法写法。
            # 🔴 旧版写的是 `if "uses" in job: continue` —— **只看键在不在**。
            # 于是 `uses:`(值为 None)、以及误缩进到 job 级的 `- uses: checkout`
            # 都被当成合法的 reusable 调用放行。实测两者都绿。
            # 现在要求它是一个非空字符串。
            if "uses" in job:
                # 🔴 真正的 reusable-workflow 调用不会同时带 runs-on / steps。
                # 两者并存的典型来源是**把 step 级的 `- uses: actions/checkout@v4`
                # 误缩进到了 job 级** —— 那个 job 于是既像调用又像 runner job,
                # 而旧版(以及我上一版只查「uses 是非空字符串」)都会放行它。
                if isinstance(job["uses"], str) and job["uses"].strip():
                    extra = [k for k in ("runs-on", "steps") if k in job]
                    if extra:
                        print(
                            f"FAIL: [uses-with-runner-keys] {rel} :: {name} —— "
                            f"reusable 调用不该同时有 {extra};"
                            f"这通常是 step 级的 uses 被误缩进到了 job 级",
                            file=sys.stderr,
                        )
                        bad += 1
                    continue
                print(
                    f"FAIL: [bad-uses] {rel} :: {name} —— uses 必须是非空字符串"
                    f"(收到 {type(job['uses']).__name__}),否则这不是一次 reusable 调用",
                    file=sys.stderr,
                )
                bad += 1
                continue
            if not job.get("runs-on"):
                print(f"FAIL: [no-runs-on] {rel} :: {name}", file=sys.stderr)
                bad += 1
            # 🔴 旧版是 `if not job.get("steps")` —— 只测真值。
            # `steps: "随便一个字符串"` 是真值,照样绿。要求它是非空**列表**。
            steps = job.get("steps")
            if not isinstance(steps, list) or not steps:
                print(
                    f"FAIL: [bad-steps] {rel} :: {name} —— steps 必须是非空列表"
                    f"(收到 {type(steps).__name__}),这个 job 什么都不会做",
                    file=sys.stderr,
                )
                bad += 1

    print(f"jobs_checked={total_jobs}")
    print(f"problems={bad}")

    if total_jobs == 0:
        print("FAIL: 扫到了 workflow 但一个 job 都没有", file=sys.stderr)
        return 1
    if bad:
        print(file=sys.stderr)
        print("  最常见的成因:合并两个相邻 job 时,git 把它们逐字相同的公共部分", file=sys.stderr)
        print("  (runs-on / timeout-minutes / steps: / - uses: actions/checkout@v4)", file=sys.stderr)
        print("  判成公共上下文、只保留了一份 —— 于是前一个 job 只剩 name。", file=sys.stderr)
        print("  解法不是「冲突块取并集」,而是把属于同一个 job 的碎片拼回完整块:", file=sys.stderr)
        print("  每个 job = 自己的头 + 公共块(各复制一份)+ 自己的体。", file=sys.stderr)
        return 1

    print()
    print(f"OK: {len(files)} 个 workflow / {total_jobs} 个 job,每个都有可执行的内容。")
    print("注意:这只说明 job 不是空壳。它会不会通过、命令对不对,这道门不管。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
