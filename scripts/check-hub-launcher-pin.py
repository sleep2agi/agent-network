#!/usr/bin/env python3
"""仓库里的 hub 启动器,必须和仓库自己声明的 hub 版本对上。

为什么需要这道门
================

`deploy/hub/hub-daemon.sh` 是 pm2 用来起生产 hub 的启动器,它里面有一行
`RUNTIME_DIR="$HOME/.commhub/runtime-vNN-previewMM"` —— **MM 决定实际起哪个版本的
commhub-server**。而 `agent-network/bin/cli.ts` 的 `PINNED_SERVER_VERSION` 是
`anet hub start` 会去拉的版本。**这两个值指的是同一件事:这个仓库认为 hub 该是哪一版。**

🔴 它们会悄悄分叉,而且分叉不会让任何东西变红:
2026-08-28 实测,`origin/main` 上启动器写 `preview29`、pin 写 `preview.34` ——
**差 5 个版本,而仓库里没有任何东西注意到。**

这不是假想。#735(2026-08-12)报的正是"仓库无法复现生产 hub 启动器",
当时的修法是**把文件拷进仓库**。16 天后它又落后了 —— 因为
**一次性拷贝没有配任何保持同步的机制,不同步不会让任何东西变红。**

这道门管什么、不管什么
======================

**管**: 仓库内部两个值一致(启动器的 previewMM == PINNED_SERVER_VERSION 的后缀)。
       这是 CI 能验证的、自洽的不变式。

🔴 **不管**: 仓库与**生产机器上那份**是否一致。CI 看不到生产机器。
       (2026-08-28 生产实际在跑 preview.35,比仓库的 pin 还新一版。)
       判断生产实际版本请查该机器的 `~/.local/bin/hub-daemon.sh` 或 `curl /health`,
       **别拿仓库里这份当生产状态的依据。**

🔴 `RUNTIME_DIR` 里的 `vNN` 是**机器本地的序号**,不参与比较 —— 两台机器升级次数不同,
   vNN 必然不同,拿它比会制造永远修不好的红。只比 previewMM。
"""
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "deploy" / "hub" / "hub-daemon.sh"
CLI = ROOT / "agent-network" / "bin" / "cli.ts"


def launcher_preview(text: str):
    """从 RUNTIME_DIR 行里取 previewMM 的 MM。取不到返回 None(而不是猜)。"""
    m = re.search(r'^RUNTIME_DIR=.*runtime-v\d+-preview(\d+)', text, re.M)
    return m.group(1) if m else None


def pinned_preview(text: str):
    """从 PINNED_SERVER_VERSION 取 -preview.MM 的 MM。"""
    m = re.search(r'const PINNED_SERVER_VERSION\s*=\s*"[\d.]+-preview\.(\d+)"', text)
    return m.group(1) if m else None


SELFTEST_EXPECTED = 4


def selftest(quiet: bool = False) -> int:
    """四个提取用例 —— 这门的全部逻辑就是两个正则，抽不到值时它**必须红而不是绿**。

    为什么必须有自检：改一次命名规则（`runtime-vNN-previewMM` → 别的形状）就会让两个
    提取函数同时返回 None，而「None vs None」看起来像「一致」。这里把「取不到」钉死。
    """
    fails = 0
    ran = 0

    ran += 1
    got = launcher_preview('RUNTIME_DIR="/x/runtime-v21-preview230/node_modules"\n')
    ok = got == "230"
    if not ok: fails.append(f"launcher 正常行应得 230，实际 {got!r}")
    elif not quiet: print("✓ selftest launcher 正常行 ⇒ 230")

    ran += 1
    got = launcher_preview('RUNTIME_DIR="/x/runtime-v21/node_modules"\n')
    ok = got is None
    if not ok: fails.append(f"launcher 无 preview 段应得 None，实际 {got!r}")
    elif not quiet: print("✓ selftest launcher 无 preview 段 ⇒ None（不是猜 0）")

    ran += 1
    got = pinned_preview('const PINNED_SERVER_VERSION = "0.9.0-preview.231";\n')
    ok = got == "231"
    if not ok: fails.append(f"pinned 正常行应得 231，实际 {got!r}")
    elif not quiet: print("✓ selftest pinned 正常行 ⇒ 231")

    ran += 1
    got = pinned_preview('const PINNED_SERVER_VERSION = "0.9.0";\n')
    ok = got is None
    if not ok: fails.append(f"pinned 无 preview 段应得 None，实际 {got!r}")
    elif not quiet: print("✓ selftest pinned 无 preview 段 ⇒ None")

    if ran != SELFTEST_EXPECTED:
        print(f"✗ 自检用例数应为 {SELFTEST_EXPECTED}，实际 {ran}", file=sys.stderr)
        return 1
    if fails:
        print("✗ 自检失败：", file=sys.stderr)
        for f in fails: print(f"    · {f}", file=sys.stderr)
        return 1
    if not quiet: print(f"✓ selftest {ran}/{ran} 通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    if not LAUNCHER.exists():
        print(f"::error::{LAUNCHER.relative_to(ROOT)} 不存在 —— #735 说的正是这个:仓库无法复现生产启动器")
        return 1
    if not CLI.exists():
        print(f"::error::{CLI.relative_to(ROOT)} 不存在")
        return 1

    lt, ct = LAUNCHER.read_text(), CLI.read_text()
    lp, pp = launcher_preview(lt), pinned_preview(ct)

    # 🔴 取不到就红,不当成"通过"。一个取不到值的检查和一个通过的检查
    #    在退出码上一模一样 —— 这正是要防的。
    if lp is None:
        print(f"::error::在 {LAUNCHER.relative_to(ROOT)} 里找不到 "
              f"`RUNTIME_DIR=...runtime-vNN-previewMM` 形态的行。"
              f"改了命名规则就要同步改这道门,别让它静默变成 no-op。")
        return 1
    if pp is None:
        print(f"::error::在 {CLI.relative_to(ROOT)} 里找不到 "
              f"`const PINNED_SERVER_VERSION = \"...-preview.MM\"`。")
        return 1

    print(f"launcher RUNTIME_DIR → preview{lp}")
    print(f"PINNED_SERVER_VERSION → preview.{pp}")

    if lp != pp:
        print(f"::error::仓库内部不一致:启动器起的是 preview{lp},而仓库声明的 hub 版本是 preview.{pp}。")
        print("  照仓库部署会起一个和 PINNED_SERVER_VERSION 不同的 hub。")
        print(f"  修法:把 {LAUNCHER.relative_to(ROOT)} 的 RUNTIME_DIR 改成 ...-preview{pp},")
        print("        并在它上方的升级记录里加一行(那段记录是回滚时唯一的线索,别省)。")
        return 1

    print(f"✅ 一致(preview{lp})。")
    print("🔴 注意:这只说明**仓库内部**自洽。它不检查生产机器上那份 —— CI 看不到生产。")
    print("   判断生产实际版本:该机器的 ~/.local/bin/hub-daemon.sh 或 curl /health。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
