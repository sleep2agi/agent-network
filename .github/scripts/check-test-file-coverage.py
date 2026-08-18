#!/usr/bin/env python3
"""元门:每个 *.test.ts 都必须落在某个聚合门的扫描范围里。

## 为什么需要这个

2026-08-13 手工扫了一遍,发现三处「有测试、但没有任何 CI job 会跑它」:
  server/src            69 个,CI 只点名跑 6 个
  agent-network/src     46 个,0 个被引用(#791 补掉)
  agent-network/tests   19 个 + agent-node/tests 6 个,两个门自称 complete 却漏了

每一处都是同一个结构:测试在本地是绿的,PR 上看不出异常,改坏了不会有人知道。
补完之后剩下的问题是 —— **下一个新增的测试文件会不会又静默漏掉?**
靠人再扫一遍不是答案。这个脚本就是答案。

## 判据

聚合门用 `find <root> -name '*.test.ts'` 覆盖若干个根。任何测试文件:
  - 落在某个根下  → 被覆盖
  - 落在 tests/<套件>/ 下 → 属于「套件自带」,单独计数并列出(它们由各自的
    Docker 套件跑,是否进 CI 由套件决定,不在本门的判据里)
  - 两者都不是 → **失败**。这是唯一的漏网形态:新包、新目录、或者把测试
    放在了聚合门扫不到的地方。

## 两条防空转

1. **根必须真的是门的扫描范围**。COVERED 是一份声明,声明会漂 —— 门被删、
   改名、或者把范围缩掉,这里就要红,否则本门会对着一份早已不成立的清单发绿。
   注意这条**不能**用子串检查:第一版写的是 `root not in text`,mutation 当场
   证伪 —— 把 find 的路径改成 $ROOT/server/nonexistent 之后,'server/src' 仍然
   出现在注释和 FAIL 文案里,门照样绿。见 declares_scope()。
2. **分母必须非零**。扫出 0 个测试文件时退出 3,而不是「没有违规,通过」——
   扫描器范围塌掉和真的没有违规,打印出来是同一片绿色。
"""

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# root → 声称覆盖它的门(run.sh 路径)。该门必须把 root 真正声明为扫描范围,见 declares_scope()。
COVERED = {
    "server/src": "tests/test798-server-unit-ci/run.sh",
    "agent-network/src": "tests/test745-agent-network-unit-ci/run.sh",
    "agent-network/tests": "tests/test745-agent-network-unit-ci/run.sh",
    "agent-node/src": "tests/test725-agent-node-unit-ci/run.sh",
    "agent-node/tests": "tests/test725-agent-node-unit-ci/run.sh",
}

# tests/<套件>/ 下的测试文件属于套件自带,单独计数
SUITE_PREFIX = "tests/"




WORKFLOW = REPO / ".github" / "workflows" / "qa.yml"


def gate_is_wired(gate: str) -> tuple[bool, str]:
    """这道门有没有真的被 CI 构建并运行。

    原来只验了两件事:门文件存在、门声明了扫描范围。**都不等于它会跑。**
    独立审(codex P1)指出:qa.yml 一旦删掉或改名某个 job、或不再 build/run
    它的 Dockerfile,本脚本照样发绿 —— 因为它从没看过 qa.yml。
    这正是本门要防的那类问题(有门、没人跑),所以不能留在自己身上。

    判据是 qa.yml 里同时出现:
      - `-f tests/<suite>/Dockerfile`(真的构建了它)
      - `docker run … <这次 build 打的 tag>`(真的跑了那个产物)
    只比 tag 字符串,不解析 YAML —— 但两条都要中,单独一条不算。
    """
    suite = Path(gate).parent.name
    if not WORKFLOW.is_file():
        return False, "qa.yml 不存在"
    wf = WORKFLOW.read_text(encoding="utf-8")
    build = re.search(rf'-f\s+tests/{re.escape(suite)}/Dockerfile', wf)
    if not build:
        return False, f"qa.yml 里没有 build tests/{suite}/Dockerfile"
    tags = re.findall(rf'-t\s+(\S+)\s+\\?\s*\n?\s*-f\s+tests/{re.escape(suite)}/Dockerfile', wf)
    if not tags:
        return False, f"qa.yml 里 build tests/{suite} 时没有 -t <tag>"
    tag = tags[0]
    if not re.search(rf'docker run[^\n]*\b{re.escape(tag)}\b', wf):
        return False, f"qa.yml 构建了 {tag} 但没有 docker run 它"
    return True, tag


def suite_is_real(path: str) -> bool:
    """`tests/<suite>/x.test.ts` 只有在那个套件真的是一套门时才豁免。

    独立审(codex P1):原来只要路径以 `tests/` 开头就放行,于是
    `tests/test999-example/new.test.ts` 这种既没有 Dockerfile 也没有 run.sh 的
    目录也能过 —— 豁免变成了「只要放对地方就不用被任何东西跑」。
    所以要求套件目录里 Dockerfile 和 run.sh 都在。

    注意这条**仍然不保证该套件进了 CI**(它可能像 test224/597/679 那样长期
    没人注册)。那是另一回事,写在 NOT COVERED 里。
    """
    parts = path.split("/")
    if len(parts) < 3:
        return False
    suite = REPO / parts[0] / parts[1]
    return (suite / "Dockerfile").is_file() and (suite / "run.sh").is_file()


def scan_depth(gate_text: str, root: str) -> int | None:
    """门扫这个根时的深度上限:1 = 只扫直属文件,None = 递归。

    这条是独立审(codex P1)抓出来的,而且当场复现:两个 unit runner 扫
    `<pkg>/tests` 用的是 `find … -maxdepth 1`,而本脚本原来只按前缀判覆盖 ——
    于是 `agent-network/tests/sub/x.test.ts` 被判为「已覆盖」,可 runner 的
    find 对它命中 0。**这道门放行了一个没人会跑的测试**,正是它存在的意义所在。

    所以深度必须从门里推导,不能假定。
    """
    m = re.search(
        rf'find\s+"\$ROOT/{re.escape(root)}"\s+(?P<flags>(?:-maxdepth\s+\d+\s+)?)',
        gate_text,
    )
    if m:
        d = re.search(r'-maxdepth\s+(\d+)', m.group("flags") or "")
        return int(d.group(1)) if d else None
    return None  # `bun test <dir>/` 形式:bun 会递归


def declares_scope(gate_text: str, root: str) -> bool:
    """门里必须真的把 root 当成扫描范围,而不是只在注释里提到它。

    第一版这里写的是 `root not in gate_text` —— 子串检查。mutation 当场证明
    它是坏的:把 find 的路径从 $ROOT/server/src 改成 $ROOT/server/nonexistent
    之后,'server/src' 仍然出现在注释和 FAIL 文案里,门照样发绿。
    宽容的断言会把不合规当合规收下。所以只认两种真实的范围声明形式。
    """
    pkg, _, sub = root.partition("/")
    patterns = [
        # find "$ROOT/<root>" … -name '*.test.ts'
        rf'find\s+"\$ROOT/{re.escape(root)}"',
        # cd /workspace/<pkg> && bun test <sub>/
        # 结尾必须锚定:`bun test src/` 才算声明整个目录。不锚的话
        # `bun test src/cli.test.ts` 也会匹配上 —— 范围收窄到单个文件,
        # 门却仍然宣称覆盖了整个 src/。第二轮 mutation 就是这么活下来的。
        rf'cd\s+/workspace/{re.escape(pkg)}\s+&&\s+bun test\s+{re.escape(sub)}/(?=[\'"\s]|$)',
    ]
    return any(re.search(p, gate_text) for p in patterns)


def tracked_test_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "*.test.ts"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    return sorted(p for p in out.splitlines() if p)


def main() -> int:
    failures: list[str] = []

    # 防空转 1:每个声明的根都要在它声称的门里字面出现
    for root, gate in COVERED.items():
        gate_path = REPO / gate
        if not gate_path.is_file():
            failures.append(f"门不存在:{gate}(声称覆盖 {root})")
            continue
        text = gate_path.read_text(encoding="utf-8")
        if not declares_scope(text, root):
            failures.append(
                f"门 {gate} 没有把 '{root}' 声明为扫描范围 —— "
                "覆盖声明与门的实际范围已经不一致"
            )
        wired, why = gate_is_wired(gate)
        # 一道门可能覆盖多个根(test745 覆盖 src 和 tests),接线问题只报一次
        msg = f"门 {gate} 没有接进 CI:{why}"
        if not wired and msg not in failures:
            failures.append(msg)

    files = tracked_test_files()
    print(f"tracked_test_files={len(files)}")

    # 防空转 2:分母为零说明扫描范围塌了,不是「没有违规」
    if not files:
        print("FAIL: 扫到 0 个 *.test.ts —— 扫描范围塌了,不是通过", file=sys.stderr)
        return 3

    by_root: dict[str, int] = {r: 0 for r in COVERED}
    suite_files: list[str] = []
    orphans: list[str] = []

    depths = {
        root: scan_depth((REPO / gate).read_text(encoding="utf-8"), root)
        if (REPO / gate).is_file() else None
        for root, gate in COVERED.items()
    }
    for f in files:
        for root in COVERED:
            if not f.startswith(root + "/"):
                continue
            rest = f[len(root) + 1:]
            d = depths[root]
            if d is not None and rest.count("/") >= d:
                # 落在门扫不到的深度里 —— 加了也不会有人跑,按漏网处理
                continue
            by_root[root] += 1
            break
        else:
            if f.startswith(SUITE_PREFIX) and suite_is_real(f):
                suite_files.append(f)
            else:
                orphans.append(f)

    for root, n in sorted(by_root.items()):
        print(f"  covered  {root:<22} {n}")
    print(f"  suite-owned (tests/<suite>/)      {len(suite_files)}")
    for f in suite_files:
        print(f"      {f}")

    total = sum(by_root.values()) + len(suite_files) + len(orphans)
    if total != len(files):
        failures.append(f"计数不闭合:分类合计 {total} != 文件数 {len(files)}")

    if orphans:
        failures.append(
            "以下测试文件不在任何聚合门的扫描范围里 —— 加了也不会有人跑:\n"
            + "\n".join(f"      {f}" for f in orphans)
            + "\n    要么把它挪进已覆盖的根,要么给它所在的包补一个聚合门"
            "(照 tests/test798-server-unit-ci 的形状)。"
        )

    if failures:
        print()
        for msg in failures:
            print(f"FAIL: {msg}", file=sys.stderr)
        return 1

    print(f"\nOK: {len(files)} 个测试文件,{len(files) - len(suite_files)} 个在聚合门范围内,"
          f"{len(suite_files)} 个套件自带,0 个漏网")
    return 0


if __name__ == "__main__":
    sys.exit(main())
