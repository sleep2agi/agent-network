#!/usr/bin/env python3
"""Pick one shard of the L1 suite list, so CI can run L1 on several runners.

Why: L1 is already parallel *inside* one job (``QA_L1_MAX_PAR = $(nproc)``), so a
4-core runner bounds the whole 87-suite set to ~20 minutes of wall clock no matter
how the cap is raised (raising it only makes absolute-timeout failures likelier —
see #1627). The remaining lever is **more runners**: split the list into N shards
and give each shard its own job.

The workflow composes this with the existing ``QA_L1_ONLY`` path in
``scripts/qa.sh`` (which validates every name against ``L1_TESTS``), so nothing in
``qa.sh`` changes:

    QA_L1_ONLY=$(python3 scripts/l1-shard.py 3 2) bash scripts/qa.sh --l1

Guards:
  * the list is read from ``scripts/qa.sh`` itself (no second copy to drift);
  * ``--verify N`` asserts the N shards partition the list exactly — every suite
    appears once, none is dropped, none is duplicated;
  * shard numbers are 1-based and must be in range.

Round-robin by position keeps the split stable when suites are appended; the
heaviest suites (test612 / test225 / test626 / test584 …) land on different
shards as long as they are not adjacent in ``L1_TESTS``. Re-balance by
re-ordering that array, not by editing this script.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

QA_SH = Path(__file__).resolve().parent / "qa.sh"


def l1_suites(qa_sh: Path = QA_SH) -> list[str]:
    text = qa_sh.read_text(encoding="utf-8")
    start = text.index("L1_TESTS=(")
    end = text.index("\n)\n", start)
    block = text[start:end]
    names: list[str] = []
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        match = re.match(r'^"([^"]+)"\s*$', stripped)
        if match:
            names.append(match.group(1))
    if not names:
        raise SystemExit("l1-shard: no suites parsed from qa.sh L1_TESTS — refusing to shard")
    if len(set(names)) != len(names):
        raise SystemExit("l1-shard: duplicate suite names in L1_TESTS")
    return names


def shard_of(names: list[str], total: int, index: int) -> list[str]:
    if not 1 <= total <= 32:
        raise SystemExit(f"l1-shard: total shards must be 1..32, got {total}")
    if not 1 <= index <= total:
        raise SystemExit(f"l1-shard: shard index must be 1..{total}, got {index}")
    return names[index - 1 :: total]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Select one shard of qa.sh's L1 suites")
    parser.add_argument("total", nargs="?", type=int, help="number of shards")
    parser.add_argument("index", nargs="?", type=int, help="1-based shard index")
    parser.add_argument("--verify", type=int, metavar="N", help="assert N shards partition the list")
    parser.add_argument("--list", action="store_true", help="print every suite, one per line")
    args = parser.parse_args(argv)

    names = l1_suites()

    if args.list:
        print("\n".join(names))
        return 0

    if args.verify is not None:
        total = args.verify
        seen: list[str] = []
        for i in range(1, total + 1):
            seen.extend(shard_of(names, total, i))
        if sorted(seen) != sorted(names) or len(seen) != len(names):
            missing = sorted(set(names) - set(seen))
            extra = sorted(set(seen) - set(names))
            raise SystemExit(f"l1-shard: shards do not partition the list; missing={missing} extra={extra}")
        sizes = [len(shard_of(names, total, i)) for i in range(1, total + 1)]
        print(f"OK: {len(names)} suites -> {total} shard(s) {sizes}; every suite appears exactly once")
        return 0

    if args.total is None or args.index is None:
        parser.error("give TOTAL and INDEX (or --verify N / --list)")

    selected = shard_of(names, args.total, args.index)
    if not selected:
        raise SystemExit(f"l1-shard: shard {args.index}/{args.total} is empty")
    # qa.sh's QA_L1_ONLY loops over whitespace-separated names.
    print(" ".join(selected))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
