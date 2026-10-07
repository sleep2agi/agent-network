#!/usr/bin/env python3
"""Every test CI actually runs must also be able to re-trigger the workflow that runs it.

`.github/workflows/qa.yml` fires on a path filter. A test directory that CI
executes but that is missing from that filter can be edited without the gate
re-running — the change ships against whatever the gate last said, and the
output looks identical to a gate that passed on the new code.

Found on 2026-08-17: three of the four test directories reached through
`scripts/qa.sh` L1_TESTS were outside the filter (test686-rest-shape-golden,
test765-batch-runtime-gate, test766-bunx-preflight), plus test292-e2e-hard-gate
which a workflow references by path. The reason it was easy to miss is that
`tests/` holds ~166 directories and only a handful are wired into CI at all, so
"most tests are not in the filter" is the normal, correct state and hides the
few that should be.

Deliberately NOT flagged: the ~160 directories no workflow executes. Listing
them would grow the filter without adding a single gate, and a filter that
triggers on unrun tests reads like coverage it does not have.

Scope is fail-closed: if the workflow, qa.sh, or tests/ cannot be found, this
exits 2 rather than reporting a clean run against nothing.
"""
import fnmatch
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("::error::PyYAML is not available — cannot parse qa.yml, refusing to pass")
    sys.exit(2)

from l1_markers import marker_names

QA_YML = Path(".github/workflows/qa.yml")
QA_SH = Path("scripts/qa.sh")
TESTS_DIR = Path("tests")
WORKFLOWS = Path(".github/workflows")
_PER_SUITE = re.compile(r"tests/([\w.\-]+)/\*\*")


def _strip_comments(text: str) -> str:
    """去掉每行的 `#` 注释。

    🔴 这不是洁癖,是一个**取集**缺陷的修复。下面的数组正则用 `[^)]*`,
    它在遇到第一个 `)` 时停下 —— 而 bash 数组里**注释是合法的**,注释里出现
    `)` 也是合法的:

        L1_TESTS=(
          # (注册这一步不是可选的 —— 一个没被调用的套件等于不存在。)
          "test823-l1-concurrency-cap"
          ...
        )

    正则在那个中文注释的 `)` 处截断,捕获到的内容里**一个套件名都没有**,
    于是 `l1_suites()` 返回 [] —— 判据完全正确,取集塌了。

    这次它 fail-closed(exit 2「parse regression」)所以被看见了。同一个洞
    如果长在一个「没找到就当没有」的检查里,就是一片安静的假绿。
    数组里的元素不会含 `#`(套件名是 kebab-case),所以按行剥注释是安全的。
    """
    return "\n".join(line.split("#", 1)[0] for line in text.split("\n"))


def bash_array(text: str, name: str) -> list[str]:
    """Entries of a `NAME=( "a" "b" )` bash array, or [] when absent."""
    m = re.search(rf"{name}=\(([^)]*)\)", _strip_comments(text), re.S)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def _on(doc: dict) -> dict:
    """YAML 1.1 把裸 `on:` 解析成 True。两条都试。"""
    if not isinstance(doc, dict):
        return {}
    on = doc.get("on", doc.get(True))
    return on if isinstance(on, dict) else {}


def event_paths(doc: dict, event: str) -> list[str]:
    block = _on(doc).get(event) or {}
    if not isinstance(block, dict):
        return []
    paths = block.get("paths") or []
    if not isinstance(paths, list):
        return []
    return [p for p in paths if isinstance(p, str)]


def suite_covered(suite: str, paths: list[str]) -> bool:
    """一条 paths 项能不能罩住 tests/<suite>/ 里的文件。注释里的字不算，调用方先解析 YAML。"""
    probe = f"tests/{suite}/run.sh"
    for p in paths:
        if p == "tests/**":
            return True
        if fnmatch.fnmatch(probe, p) or fnmatch.fnmatch(probe, p.replace("**", "*")):
            return True
    return False


def named_suites(paths: list[str]) -> set[str]:
    """`tests/<名>/**` 这种逐套件项点到的名字。`tests/**` 不点名。"""
    found = set()
    for p in paths:
        m = _PER_SUITE.fullmatch(p)
        if m:
            found.add(m.group(1))
    return found


def main() -> int:
    for p in (QA_YML, QA_SH, TESTS_DIR):
        if not p.exists():
            print(f"::error::{p} not found — scope regression, refusing to pass")
            return 2

    test_dirs = {d.name for d in TESTS_DIR.iterdir() if d.is_dir() and d.name.startswith("test")}
    if not test_dirs:
        print(f"::error::no test directories under {TESTS_DIR} — scope regression, refusing to pass")
        return 2

    qa_sh = QA_SH.read_text(encoding="utf-8", errors="replace")
    # L1 只认普通文件 tests/<名>/qa.l1，名字不以点开头。和 qa.sh 同一条规则。
    # L0 的条目是源文件名，只有真能对上 tests/ 目录的才算。
    executed = set(marker_names(TESTS_DIR))
    executed |= {e for e in bash_array(qa_sh, "L0_TESTS") if e in test_dirs}

    # Anything a workflow references by path is executed too.
    for wf in sorted(list(WORKFLOWS.glob("*.yml")) + list(WORKFLOWS.glob("*.yaml"))):
        body = wf.read_text(encoding="utf-8", errors="replace")
        # A path filter entry is not a reference to running it — strip those
        # first, or every listed dir would look self-justifying.
        body = re.sub(r"^\s*-\s*'tests/[^']+'\s*$", "", body, flags=re.M)
        executed |= {m.rstrip("/") for m in re.findall(r"tests/(test[\w.\-]+)", body)} & test_dirs

    if not executed:
        print("::error::no CI-executed test directories detected — the parser probably "
              "stopped matching qa.sh or the workflows; refusing to pass")
        return 2

    qa_text = QA_YML.read_text(encoding="utf-8")
    # 子串 `- 'tests/**'` 写在注释里也能命中。必须看解析后的 paths 列表。
    try:
        doc = yaml.safe_load(qa_text)
    except yaml.YAMLError as e:
        print(f"::error::qa.yml is not valid YAML ({e}) — refusing to pass")
        return 2
    if not isinstance(doc, dict):
        print("::error::qa.yml did not parse to a mapping — refusing to pass")
        return 2
    pr_paths = event_paths(doc, "pull_request")
    push_paths = event_paths(doc, "push")
    if not pr_paths or not push_paths:
        print("::error::qa.yml is missing on.pull_request.paths or on.push.paths — refusing to pass")
        return 2
    # 两边都要罩住。只写在一边，另一边改了不会重跑。
    covered = {s for s in executed if suite_covered(s, pr_paths) and suite_covered(s, push_paths)}
    gap = sorted(executed - covered)

    print(f"tests/ directories: {len(test_dirs)} · CI-executed: {len(executed)} · "
          f"in qa.yml path filter: {len(covered)}")

    if gap:
        for d in gap:
            print(f"::error file={QA_YML}::tests/{d} is executed by CI but missing from the "
                  f"qa.yml path filter — editing it will not re-run its own gate.\n"
                  f"    Put `- 'tests/**'` on both pull_request and push. "
                  f"Do not add another per-suite line.")
        print(f"\n{len(gap)} executed test directory/ies outside the trigger filter.")
        return 1

    stale = sorted((named_suites(pr_paths) | named_suites(push_paths)) - executed)
    if stale:
        # Not a failure: a dir may be listed ahead of being wired up. But say it,
        # because a filter entry for something CI never runs is coverage theatre.
        print("note: in the filter but not executed by CI (harmless, but not coverage): "
              + ", ".join(stale))

    print(f"all {len(executed)} CI-executed test directory/ies can re-trigger qa.yml.")
    return 0


def selftest() -> int:
    """注释里的 `tests/**` 不能当成真的 paths 项。解析后的列表才能算。"""
    spoof = """
# - 'tests/**'
on:
  pull_request:
    paths:
      - 'server/**'
      # - 'tests/**'
  push:
    paths:
      - 'server/**'
"""
    real = """
on:
  pull_request:
    paths:
      - 'tests/**'
      - 'server/**'
  push:
    branches: [main]
    paths:
      - 'server/**'
      - 'tests/**'
"""
    one_side = """
on:
  pull_request:
    paths:
      - 'tests/**'
  push:
    paths:
      - 'server/**'
"""
    per_suite = """
on:
  pull_request:
    paths:
      - 'tests/qa-a/**'
  push:
    paths:
      - 'tests/qa-a/**'
"""
    cases = []

    def check(name: str, ok: bool) -> None:
        cases.append((name, ok))

    spoof_doc = yaml.safe_load(spoof)
    check("注释里的 tests/** 不进 paths", "tests/**" not in event_paths(spoof_doc, "pull_request"))
    check("注释骗得过子串，骗不过解析", "- 'tests/**'" in spoof and not suite_covered("qa-a", event_paths(spoof_doc, "pull_request")))
    real_doc = yaml.safe_load(real)
    check("pull_request 的 tests/** 罩住套件", suite_covered("qa-a", event_paths(real_doc, "pull_request")))
    check("push 的 tests/** 罩住套件", suite_covered("qa-a", event_paths(real_doc, "push")))
    one = yaml.safe_load(one_side)
    check("只写在 pull_request 一边不算 push 罩住", not suite_covered("qa-a", event_paths(one, "push")))
    per = yaml.safe_load(per_suite)
    check("逐套件项仍然罩住自己", suite_covered("qa-a", event_paths(per, "pull_request")))
    check("逐套件项不罩住别人", not suite_covered("qa-b", event_paths(per, "pull_request")))
    check("逐套件项能点出名字", named_suites(event_paths(per, "pull_request")) == {"qa-a"})
    check("tests/** 不点名", named_suites(event_paths(real_doc, "pull_request")) == set())

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
