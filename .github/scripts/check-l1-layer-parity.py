#!/usr/bin/env python3
"""L1 套件的层不能在收集方式换掉之后悄悄变掉。

看板 #675。L1 的成员是 tests/<套件>/qa.l1，不再是 scripts/qa.sh 里的一份
手写数组，也不再是 qa.yml 里逐套件的 paths 行。这份清单是换收集方式之前
每个套件所在的层。之后：

  - 新增一个 qa.l1，而清单里没有它 → 红
  - 删掉一个 qa.l1，而清单里还有它 → 红
  - 同一个套件从 L1 换到某个 job，或反过来 → 红

有意改层的 PR 要同时改 .github/scripts/l1-layer-inventory.txt。
零条清单或零个活套件是取集塌了，退 2，不当成通过。

tests/** 会让只改孤儿套件或豁免套件的 PR 也触发整份 qa workflow。
那些套件自己仍然不跑。说明写在 docs/qa/README.md。
"""
from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

try:
    import yaml
except ImportError:
    print("::error::PyYAML is not available — cannot parse qa.yml, refusing to pass")
    sys.exit(2)

REPO = Path(__file__).resolve().parents[2]
INVENTORY = REPO / ".github" / "scripts" / "l1-layer-inventory.txt"
QA_YML = REPO / ".github" / "workflows" / "qa.yml"
TESTS = REPO / "tests"

_SUITE_REF = re.compile(r"tests/([A-Za-z0-9_.-]+)/")


def marker_names(tests: Path) -> list[str]:
    """目录里有 qa.l1 的套件。没有这个文件的 run.sh 不算 L1。"""
    if not tests.is_dir():
        return []
    names = [p.name for p in tests.iterdir() if p.is_dir() and (p / "qa.l1").is_file()]
    return sorted(names)


def _is_suite_dir(tests: Path, name: str) -> bool:
    d = tests / name
    if not d.is_dir():
        return False
    if (d / "qa.l1").is_file() or (d / "run.sh").is_file() or (d / "docker-compose.yml").is_file():
        return True
    return any(
        p.is_file() and (p.name == "Dockerfile" or p.name.startswith("Dockerfile."))
        for p in d.iterdir()
    )


def _refs_in_run(text: str) -> set[str]:
    found: set[str] = set()
    for line in text.splitlines():
        code = line.split("#", 1)[0]
        found.update(_SUITE_REF.findall(code))
    return found


def job_members(doc: dict, tests: Path) -> dict[str, set[str]]:
    """每个 qa.yml job 实际点名的套件。

    矩阵的 suite 列表算数。step 的 run 里出现 tests/<套件>/ 也算数。
    shell 注释不算。tests/lib 这种支持目录不算，除非它自己就是矩阵项。
    """
    jobs = doc.get("jobs") or {}
    out: dict[str, set[str]] = {}
    for jid, job in jobs.items():
        if not isinstance(job, dict):
            continue
        members: set[str] = set()
        matrix = ((job.get("strategy") or {}).get("matrix") or {}).get("suite")
        if isinstance(matrix, list):
            members.update(s for s in matrix if isinstance(s, str))
        for step in job.get("steps") or []:
            if isinstance(step, dict) and isinstance(step.get("run"), str):
                for name in _refs_in_run(step["run"]):
                    if name in members or _is_suite_dir(tests, name):
                        members.add(name)
        if members:
            out[jid] = members
    return out


def live_layers(tests: Path, qa_text: str) -> dict[str, set[str]]:
    doc = yaml.safe_load(qa_text)
    layers: dict[str, set[str]] = {}
    for name in marker_names(tests):
        layers.setdefault(name, set()).add("l1")
    for jid, members in job_members(doc, tests).items():
        for name in members:
            layers.setdefault(name, set()).add(f"job:{jid}")
    return layers


def format_tags(tags: set[str]) -> str:
    return ",".join(sorted(tags))


def load_inventory(path: Path) -> dict[str, set[str]] | None:
    """None = 文件不存在。空 dict = 文件在但一条套件都没有。两者都要退 2。"""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    inv: dict[str, set[str]] = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" not in line:
            raise ValueError(f"{path}:{lineno}: 缺 tab")
        name, tags = line.split("\t", 1)
        if not name or name in inv:
            raise ValueError(f"{path}:{lineno}: 套件名空或重复 ({name})")
        parts = {p for p in tags.split(",") if p}
        if not parts:
            raise ValueError(f"{path}:{lineno}: {name} 没有层")
        inv[name] = parts
    return inv


def diff_layers(inventory: dict[str, set[str]], live: dict[str, set[str]]) -> list[str]:
    """返回红的原因。空列表才是同一层。"""
    problems = []
    for name in sorted(set(inventory) | set(live)):
        want = inventory.get(name)
        got = live.get(name)
        if want == got:
            continue
        if want is None:
            problems.append(
                f"::error::新增套件 {name} 的层是 ({format_tags(got or set())})，"
                "清单里没有它。把这一行加进 l1-layer-inventory.txt，或删掉多出来的 qa.l1。"
            )
        elif got is None:
            problems.append(
                f"::error::套件 {name} 清单里是 ({format_tags(want)})，现在不在任何层。"
                "qa.l1 被删掉时要同时改清单。"
            )
        else:
            problems.append(
                f"::error::套件 {name} 换层了：清单 ({format_tags(want)}) ，"
                f"现在 ({format_tags(got)})。"
            )
    return problems


def main() -> int:
    if not QA_YML.is_file():
        print(f"::error::{QA_YML} 不存在 —— 取集塌了，拒绝通过")
        return 2
    try:
        inventory = load_inventory(INVENTORY)
    except ValueError as e:
        print(f"::error::{e}")
        return 2
    if inventory is None:
        print(f"::error::{INVENTORY} 不存在 —— 没有楼层可比，拒绝通过")
        return 2
    if not inventory:
        print(f"::error::{INVENTORY} 是空的 —— 零个套件和全绿不能是同一种输出")
        return 2
    live = live_layers(TESTS, QA_YML.read_text(encoding="utf-8"))
    if not live:
        print("::error::qa.l1 和 qa.yml job 都没有取到套件 —— 取集塌了，拒绝通过")
        return 2
    problems = diff_layers(inventory, live)
    l1_inv = sorted(n for n, tags in inventory.items() if "l1" in tags)
    l1_live = sorted(n for n, tags in live.items() if "l1" in tags)
    print(
        f"inventory={len(inventory)} live={len(live)} "
        f"l1_inventory={len(l1_inv)} l1_markers={len(l1_live)} "
        f"moved={len(problems)}"
    )
    for line in problems:
        print(line)
    if problems:
        return 1
    print("every suite is still in the same layer.")
    return 0


def selftest() -> int:
    """取集自检：加一个 qa.l1 必须红，删一个 qa.l1 必须红。

    自检退出码 0 表示「门正确地红了」。门本身对那种树是非 0。
    """
    cases: list[tuple[str, bool]] = []

    def check(name: str, ok: bool) -> None:
        cases.append((name, ok))

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        tests = root / "tests"
        (tests / "suite-a").mkdir(parents=True)
        (tests / "suite-a" / "qa.l1").write_text("\n", encoding="utf-8")
        (tests / "suite-a" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (tests / "suite-b").mkdir()
        (tests / "suite-b" / "qa.l1").write_text("\n", encoding="utf-8")
        (tests / "suite-b" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (tests / "suite-job").mkdir()
        (tests / "suite-job" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (tests / "lib").mkdir()
        (tests / "lib" / "helper.sh").write_text("x\n", encoding="utf-8")
        qa = """
jobs:
  recovered-suites:
    steps:
      - run: |
          docker build -f tests/suite-job/Dockerfile .
          # tests/suite-comment-only/Dockerfile
          docker build -f tests/lib/Dockerfile .
  hub-orphan-gates:
    strategy:
      matrix:
        suite:
          - suite-a
          - suite-b
"""
        live = live_layers(tests, qa)
        check("标记 a,b 都在 l1", live.get("suite-a") == {"l1", "job:hub-orphan-gates"}
              and "l1" in live.get("suite-b", set()))
        check("run 里的套件进 job", live.get("suite-job") == {"job:recovered-suites"})
        check("注释里的套件不算", "suite-comment-only" not in live)
        check("支持目录 tests/lib 不算套件", "lib" not in live)
        check("没有 qa.l1 的 suite-job 不在 l1", "l1" not in live.get("suite-job", set()))

        inventory = {
            "suite-a": {"l1", "job:hub-orphan-gates"},
            "suite-b": {"l1", "job:hub-orphan-gates"},
            "suite-job": {"job:recovered-suites"},
        }
        check("收集前后同一层 → 不红", diff_layers(inventory, live) == [])

        added = dict(live)
        added["suite-new"] = {"l1"}
        add_errs = diff_layers(inventory, added)
        check("新增 qa.l1 → 红", len(add_errs) == 1 and "suite-new" in add_errs[0])

        deleted = {k: set(v) for k, v in live.items() if k != "suite-b"}
        del_errs = diff_layers(inventory, deleted)
        check("删掉 qa.l1 → 红", len(del_errs) == 1 and "suite-b" in del_errs[0])

        moved = {k: set(v) for k, v in live.items()}
        moved["suite-job"] = {"l1", "job:recovered-suites"}
        move_errs = diff_layers(inventory, moved)
        check("换层 → 红", len(move_errs) == 1 and "suite-job" in move_errs[0])

        # 磁盘上真的加一个标记、删一个标记，再取一次集。
        (tests / "suite-new").mkdir()
        (tests / "suite-new" / "qa.l1").write_text("\n", encoding="utf-8")
        (tests / "suite-new" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        live_added = live_layers(tests, qa)
        check("取集看见新标记", "suite-new" in live_added and "l1" in live_added["suite-new"])
        check("新标记对原清单是红", any("suite-new" in e for e in diff_layers(inventory, live_added)))
        (tests / "suite-b" / "qa.l1").unlink()
        live_deleted = live_layers(tests, qa)
        check("取集不再把删掉标记的套件当 l1", "l1" not in live_deleted.get("suite-b", set()))
        check("删标记对原清单是红", any("suite-b" in e for e in diff_layers(inventory, live_deleted)))

    check("空清单文件 → None 与空 dict 分开", load_inventory(Path("/no/such/l1-layer-inventory.txt")) is None)
    with tempfile.TemporaryDirectory() as td:
        empty = Path(td) / "inv.txt"
        empty.write_text("# only a comment\n", encoding="utf-8")
        check("只有注释的清单是空 dict", load_inventory(empty) == {})

    bad = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}")
    if bad:
        print(f"::error::selftest failed: {len(bad)} case(s)")
        return 1
    print(f"selftest: {len(cases)}/{len(cases)} ok")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
