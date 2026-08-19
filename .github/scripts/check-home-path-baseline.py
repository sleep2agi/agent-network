#!/usr/bin/env python3
"""No NEW `/home/<someone>/` paths in this public repository.

Measured on origin/main 2026-08-18: 82 tracked files carry 202 occurrences of a
hardcoded home directory, spanning 14 distinct names that look like real people
(system accounts — ubuntu / root / runner / node / ci — account for zero of them).
This repository is public, so those are exposed.

🔴 This gate does NOT require zero, and that is deliberate.

Most of the 82 are in docs/ and tests/, and a good share of them are part of an
incident record — a transcript, a pane capture, a path that appears in the
command someone actually ran. Scrubbing those makes the evidence stop matching
what happened, which is its own kind of damage. Cleaning them up is a judgement
call per file, not something a gate can drive.

A gate that demanded zero would be red from its first day, and a gate that is red
only because of a backlog stops meaning anything the moment the backlog clears —
nobody can tell whether it still works. A baseline gate is green today and red on
anything NEW, which is the property worth having.

The baseline is per file, not a single total: a scalar would let a new file slip
in whenever an old one lost a line. Cleanups are welcome — the gate tells you to
lower the baseline when a file improves, so the floor only ever ratchets down.

Fail-closed: scanning zero files is a scope regression (exit 2), not a clean run.
"""
import collections
import re
import subprocess
import sys

BASELINE = "docs/home-path-baseline.txt"

# 🔴 两处修正（2026-08-19，实测 origin/main 3fd3e4bb）：
#
# ① **不再要求结尾斜杠。** 旧写法 `/home/([A-Za-z0-9._-]+)/` 漏掉 38 处 / 20 个文件，
#    而漏掉的恰恰是这个门最该看见的形状：
#        tests/test736-pm2-fleet-rebuild/Dockerfile:22  ENV HOME=/home/<名>
#        tests/test736-pm2-fleet-rebuild/Dockerfile:19  chown -R <名>:<名> /home/<名>
#        agent-network/src/grok-copresence-profile.test.ts  HOME: "/home/<名>"
#    这些位置对棘轮是**隐形**的 —— 在那儿新增一条，门不会发现。
#    旧 selftest 有一条 `regex needs the trailing slash` 把这个行为**钉成了正确的**；
#    本次把那条钉改掉，并在下面用两条新夹具钉住新行为。
#
# ② **加根边界。** 旧写法会把 `/runtime/home/x/`、`$case_root/home/.anet` 里的
#    `/home/` 也算进来 —— 那不是系统家目录。实测 198 处计入里有 **18 处是这类误报**。
#
# ⇒ 净效果：计入 198 → 218（+38 真命中，−18 误报）。**基线随之重算。**
#    地板变高不是「更宽容」，是**看见的东西变多了**；这两个数写在这里，
#    是为了让下一个人能判断它该不该再变。
HOME_PATH = re.compile(r"(?<![A-Za-z0-9._-])/home/([A-Za-z0-9._-]+)")

# Names that are documentation placeholders or machine accounts rather than a
# person. Kept explicit (and covered by --selftest) because the count moves when
# this set changes: someone who introduces a new placeholder spelling would
# otherwise see the number jump and not know whether they caused it.
NOT_A_PERSON = {
    "user", "USER", "username", "USERNAME", "youruser", "your-user", "your_user",
    "me", "someone", "name", "NAME", "test", "testuser", "example",
    # machine / CI accounts — a path under these leaks nothing about a person
    "ubuntu", "root", "runner", "node", "ci", "runneradmin",
}


def is_person(name: str) -> bool:
    """A `/home/<name>/` worth counting: not a placeholder, not a machine account."""
    if name in NOT_A_PERSON:
        return False
    if len(name) <= 2:  # `/home/x/` in a diagram, not a login
        return False
    return True


def scan() -> tuple[dict[str, int], int]:
    """Per-file counts of person-looking home paths, plus files searched."""
    listing = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=False
    ).stdout.split("\n")
    tracked = [f for f in listing if f]

    out = subprocess.run(
        ["git", "grep", "-InE", r"(^|[^A-Za-z0-9._-])/home/[A-Za-z0-9._-]+"],
        capture_output=True, text=True, check=False,
    ).stdout

    counts: dict[str, int] = collections.Counter()
    for line in out.split("\n"):
        if not line:
            continue
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        path, _lineno, text = parts
        hits = sum(1 for n in HOME_PATH.findall(text) if is_person(n))
        if hits:
            counts[path] += hits
    return dict(counts), len(tracked)


def read_baseline() -> dict[str, int]:
    base: dict[str, int] = {}
    try:
        for line in open(BASELINE, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            path, _, n = line.rpartition("\t")
            base[path] = int(n)
    except FileNotFoundError:
        return {}
    return base


def main() -> int:
    counts, tracked = scan()
    if tracked == 0:
        print("::error::git ls-files returned nothing — scope regression, refusing to pass")
        return 2

    base = read_baseline()
    if not base:
        print(f"::error::{BASELINE} is missing or empty — refusing to pass without a floor to compare against")
        return 2

    problems = 0
    for path, n in sorted(counts.items()):
        allowed = base.get(path, 0)
        if n > allowed:
            problems += 1
            what = "new file with" if path not in base else f"{allowed} → {n}"
            print(
                f"::error file={path}::{what} hardcoded /home/<name>/ path(s). This repository is "
                f"public. Use $HOME, ~, or a placeholder like /home/user/. If this line is part of "
                f"an incident record and the real path is load-bearing, say so in the PR and raise "
                f"the number for this file in {BASELINE}."
            )

    improved = [p for p, n in base.items() if counts.get(p, 0) < n]
    print(
        f"scanned {tracked} tracked file(s); {sum(counts.values())} person-looking /home/ path(s) "
        f"across {len(counts)} file(s); baseline covers {len(base)} file(s)"
    )
    if improved:
        print(
            f"note: {len(improved)} file(s) now carry fewer than the baseline allows — lower their "
            f"numbers in {BASELINE} so the floor ratchets down and cannot silently refill."
        )
    if problems:
        print(f"\n{problems} file(s) above baseline.")
        return 1
    print("no file is above its baseline.")
    return 0


def selftest() -> int:
    """Pin the classifier. It decides WHAT gets counted, so it decides the number."""
    # 🔴 这些夹具刻意不写成字面量 `/home/<名字>/`,而是拼出来的。
    # 一个扫描器的测试夹具如果长得就像它要扫的那个东西,它会扫到自己 ——
    # 提交这个文件的那一刻,基线里就多出一个文件、一次命中,而那次命中不是缺陷。
    # (同一个坑今晚在另一处出现过:一条断言被它自己解释用的注释绊倒。)
    # 名字也用合成的,不用任何真实登录名 —— 这个仓是公开的。
    slash = "/"
    home = f"{slash}home{slash}"
    cases = [
        ("a plain login name counts", is_person("zqxjkv")),
        ("documentation placeholder does not", not is_person("user")),
        ("uppercase placeholder does not", not is_person("USER")),
        ("machine account does not", not is_person("runner")),
        ("root does not", not is_person("root")),
        ("single letter does not", not is_person("x")),
        ("two letters do not", not is_person("ab")),
        ("three letters do", is_person("abc")),
        ("regex finds the name between slashes", HOME_PATH.findall(f"cd {home}zqxjkv{slash}work") == ["zqxjkv"]),
        # 🔴 这三条替换掉旧的 `regex needs the trailing slash` —— 那条钉住的是
        # 一个会漏掉 `ENV HOME=/home/<名>` 的行为。
        ("a path with no trailing slash still counts", HOME_PATH.findall(f"{home}zqxjkv") == ["zqxjkv"]),
        ("a home dir nested under another path does not count",
         HOME_PATH.findall(f"{slash}runtime{home}zqxjkv{slash}x") == []),
        ("a var-rooted home dir does not count",
         HOME_PATH.findall(f"$case_root{home}zqxjkv") == []),
        ("two paths on one line are both found", len(HOME_PATH.findall(f"{home}aaa{slash}x {home}bbb{slash}y")) == 2),
    ]
    bad = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}")
    if bad:
        print(f"::error::classifier selftest failed: {len(bad)} case(s)")
        return 1
    print(f"selftest: {len(cases)}/{len(cases)} ok")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
