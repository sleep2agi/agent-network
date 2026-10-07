#!/usr/bin/env python3
"""L1 取集，和 scripts/qa.sh 的 glob 用同一条规则。

只认 tests/<名>/qa.l1 这个普通文件，目录名不以点开头。
隐藏目录不收。qa.l1 是目录或断链不收。指向普通文件的符号链接收
（bash 的 [[ -f ]] 也收）。

qa.sh 才是「实际跑哪些」的那份。这只是让各道门在碰到隐藏目录、
非普通文件时不要和它对着干。少收一个套件由 parity 门去跑
`bash scripts/qa.sh --list` 抓，不在这里再写一份 glob。
"""
from __future__ import annotations

from pathlib import Path


def is_l1_marker(suite: Path) -> bool:
    """suite 是 tests 下的一层目录。名字以点开头，或 qa.l1 不是普通文件，都不是 L1。"""
    if suite.name.startswith("."):
        return False
    marker = suite / "qa.l1"
    # is_file() 跟随符号链接：普通文件、以及指向普通文件的链接，才是 True。
    # 目录和断链都是 False。
    return marker.is_file()


def marker_names(tests: Path) -> list[str]:
    """有 qa.l1 普通文件的套件名，按 Python 默认排序（ASCII 名与 LC_ALL=C 一致）。"""
    if not tests.is_dir():
        return []
    return sorted(p.name for p in tests.iterdir() if p.is_dir() and is_l1_marker(p))
