#!/usr/bin/env python3
"""Check the published Hub V2 contract inputs against one git commit.

The bundled desktop pin is the published tarball of preview.120, built from
sourceCommit, not from whatever server/src happens to be at HEAD. Hash each
listed file with `git show <commit>:server/<path>`. Do not regenerate the
manifest from the worktree.

2026-10-31 —— 抽出 verify() 以便自检（元门要求每个已接线的门都有 --selftest）。
被抽出的那部分是这门的**全部判据**：把「清单里的期望哈希」与「某个提交里的字节」逐条比。
自检用假数据跑两条路径（全对 / 有一条不符），否则「跑过」与「什么都没查」同形。
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]


def verify(manifest: dict, read_blob) -> tuple[bool, list[str]]:
    """→ (是否全对, 逐行输出)。read_blob(rel) 返回该提交里 server/<rel> 的字节。"""
    lines: list[str] = []
    failed = False
    for rel, expected in manifest["files"].items():
        try:
            blob = read_blob(rel)
        except Exception as exc:  # noqa: BLE001
            lines.append(f"FAIL: {rel} 读不到（{exc}）")
            failed = True
            continue
        actual = hashlib.sha256(blob).hexdigest()
        ok = actual == expected
        lines.append(f"{'PASS' if ok else 'FAIL'}: {rel} {actual}")
        failed = failed or not ok
    return (not failed), lines


SELFTEST_EXPECTED = 4


def selftest(quiet: bool = False) -> int:
    fails = 0
    body = b"hello"
    good = hashlib.sha256(body).hexdigest()

    ran = 0
    ok, lines = verify({"files": {"a.ts": good}}, lambda rel: body)
    ran += 1
    if not ok or len(lines) != 1 or not lines[0].startswith("PASS"):
        fails += 1
    elif not quiet:
        print("✓ selftest 哈希相符 ⇒ PASS")

    ran += 1
    ok, lines = verify({"files": {"a.ts": "0" * 64}}, lambda rel: body)
    if ok or not lines[0].startswith("FAIL"):
        fails += 1
    elif not quiet:
        print("✓ selftest 哈希不符 ⇒ FAIL")

    ran += 1
    def boom(rel):
        raise RuntimeError("no such path")
    ok, lines = verify({"files": {"a.ts": good}}, boom)
    if ok or "读不到" not in lines[0]:
        fails += 1
    elif not quiet:
        print("✓ selftest 读不到 ⇒ FAIL 且说清原因")

    ran += 1
    ok, lines = verify({"files": {}}, lambda rel: body)
    if not ok or lines:
        fails += 1
    elif not quiet:
        print("✓ selftest 空清单 ⇒ 全对且无输出（空清单由调用方另行判定）")

    if ran != SELFTEST_EXPECTED:
        print(f"✗ 自检用例数应为 {SELFTEST_EXPECTED}，实际 {ran}", file=sys.stderr)
        return 1
    if fails:
        print(f"✗ 自检失败 {fails} 例", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {ran}/{ran} 通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2

    manifest = json.loads((root / "docs/tests/hub-v2-protocol-inputs.json").read_text())
    commit = manifest["sourceCommit"]
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        sys.exit("sourceCommit must be a 40-character hex git id")
    if not manifest["files"]:
        # 空清单会让「全部相符」变成真空真 —— 与 0 覆盖率同形
        sys.exit("FAIL: 清单里没有任何文件（空清单不是「全部相符」）")

    ok, lines = verify(manifest, lambda rel: subprocess.check_output(["git", "show", f"{commit}:server/{rel}"]))
    for line in lines:
        print(line)
    if not ok:
        sys.exit(1)
    print(f"PASS: {manifest['package']}@{manifest['version']} inputs match {commit}")
    # 2026-10-31 —— 外部复核 (c)：「两份内容不同、声明 commit 不同的产物**都是 exit 0**；
    # 且 checker 一次都没读 metadata.source ⇒ 自洽是免费的，绿只说明手续齐全。」
    # 本门同构：它证明的是「清单 ↔ 某个 commit 的字节」自洽。
    # 它**不**证明「那个 commit 就是已发布 tarball 的来源」—— 把清单换成另一颗 sha
    # 重新生成，本门依然全绿。所以这一行必须自己说出来，读者才不该把别的期待压上来。
    print(f"  证明：清单里的期望哈希 ↔ {commit[:12]} 的字节，逐条相符")
    print("  不证明：该 commit 就是已发布包的来源（清单换成另一颗 sha 仍会全绿）")
    print("          ⇒ 要证那一步，只能靠发布记录（release.yml 的 commit 输入）或 tarball 内容比对")
    return 0


if __name__ == "__main__":
    sys.exit(main())
