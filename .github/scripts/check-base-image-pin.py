#!/usr/bin/env python3
"""新增的 Dockerfile 不许再用完全浮动的基础镜像 tag（`:latest` 或不带 tag）。

`FROM oven/bun:latest` 构建出什么，**取决于构建那一刻上游是什么**。
本仓 CI 上没有任何 docker 层缓存（`qa.yml` 里 cache 相关命中 = 0，
全部 `runs-on: ubuntu-latest`），所以每次都真去拉一次上游最新 ——
同一个提交今天和明天的镜像可能不同，一次红/绿因此不可复现。

🔴 **只判「完全浮动」，不判浮动大版本（`:1` / `:22`）。**
实测（2026-09-02，origin/main）278 条 FROM 里浮动大版本有 **128** 条，
一次性收紧会让这道门在第一周就被关掉。先堵住最严重的一档。
（同一个理由见 `check-bun-install-pin.py` 头注：新检查要对齐产品既有立场，不能更严。）

🔴 **这道门不要求存量清零**：存量写进 baseline 记账，只禁新增。

🔴 **取集直接复用 `check-bun-install-pin.py` 的 `is_dockerfile()`，不重写。**
2026-09-02 我重写过一个 `(^|/)Dockerfile[^/]*$`，漏掉 7 个 `xxx.Dockerfile`
后缀式文件（`playwright.Dockerfile` 等）——**而那道门的 selftest 里正好
写着这个坑**。分母做小会让问题看起来更轻。

用法：
    python3 .github/scripts/check-base-image-pin.py            # 跑门
    python3 .github/scripts/check-base-image-pin.py --selftest # 判据 + 取集两层自检
"""
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

BASELINE = "docs/base-image-pin-baseline.txt"
FROM_RE = re.compile(r"^\s*FROM\s+(\S+)", re.M | re.I)
ARG_RE = re.compile(r"^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)", re.M | re.I)
VAR_RE = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")


def _load_is_dockerfile():
    """复用同族那道门的取集谓词。文件名带连字符，只能按路径 import。"""
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "_bun_pin", here / "check-bun-install-pin.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.is_dockerfile


is_dockerfile = _load_is_dockerfile()


def resolve(tag: str, text: str) -> str:
    """`FROM ${VAR}` → 用同文件里 `ARG VAR=default` 的默认值替换。

    解析不出默认值时原样返回 —— 由 unpinned() 判成「不判」，宁可漏不可误报。
    """
    m = VAR_RE.match(tag)
    if not m:
        return tag
    for name, val in ARG_RE.findall(text):
        if name == m.group(1):
            return val
    return tag


def unpinned(tag: str, text: str = "") -> bool:
    """完全浮动 = 显式 `:latest`，或根本没有 tag。"""
    t = resolve(tag, text)
    if VAR_RE.match(t):          # 仍是变量且查不到默认值 ⇒ 不判
        return False
    if "@sha256:" in t:
        return False
    name = t.split("@", 1)[0]
    # 冒号可能出现在 registry 的端口里（host:5000/img），只看最后一段
    last = name.rsplit("/", 1)[-1]
    if ":" not in last:
        return True              # 无 tag ⇒ 等价于 :latest
    return last.rsplit(":", 1)[1] == "latest"


def offenders(text: str):
    return [t for t in FROM_RE.findall(text) if unpinned(t, text)]


def selftest() -> int:
    cases = []

    def ck(name, tag, text, want):
        got = unpinned(tag, text)
        cases.append((name, got == want, f"got={got} want={want}"))

    ck("显式 latest → 未钉", "oven/bun:latest", "", True)
    ck("无 tag → 未钉", "node", "", True)
    ck("精确版 → 已钉", "oven/bun:1.3.14", "", False)
    ck("sha 钉死 → 已钉", "oven/bun:1.3.14@sha256:abc", "", False)
    # 🔴 浮动大版本**故意不判** —— 128 条存量，一次收紧这道门会被关掉
    ck("浮动大版本 :1 → 不判", "oven/bun:1", "", False)
    ck("浮动大版本 :22 → 不判", "node:22-bookworm-slim", "", False)
    # 🔴 ARG 变量：默认值带 tag ⇒ 已钉；默认值是 latest ⇒ 未钉；查不到 ⇒ 不判
    ck("ARG 默认值带 tag → 已钉", "${B}", "ARG B=anet-x:ec0ead84\nFROM ${B}", False)
    ck("ARG 默认值是 latest → 未钉", "${B}", "ARG B=node:latest\nFROM ${B}", True)
    ck("ARG 查不到默认值 → 不判", "${B}", "FROM ${B}", False)
    # 🔴 registry 端口不能被当成 tag
    ck("registry 带端口无 tag → 未钉", "reg.local:5000/img", "", True)
    ck("registry 带端口有 tag → 已钉", "reg.local:5000/img:1.2.3", "", False)

    # ── 取集自检：这道门的坏法是「圈错哪些文件算 Dockerfile」。
    #    直接喂复用来的 is_dockerfile()，确认它真的收进后缀式。
    def ckname(path, want):
        got = is_dockerfile(path)
        cases.append((f"取集 {path}", got == want, f"got={got} want={want}"))

    ckname("Dockerfile", True)
    ckname("tests/x/Dockerfile.mock", True)
    ckname("tests/x/playwright.Dockerfile", True)   # 🔴 后缀式，我重写取集时漏过
    ckname("tests/x/README.md", False)

    for n, ok, d in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}   [{d}]")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=True).stdout.strip())
    tracked = subprocess.run(["git", "ls-files"], cwd=repo,
                             capture_output=True, text=True, check=True).stdout.split("\n")
    files = [f for f in tracked if f and is_dockerfile(f)]
    if not files:
        print("::error::扫到 0 个 Dockerfile —— 取集坏了，不是仓里没有", file=sys.stderr)
        return 2

    current = set()
    for f in files:
        try:
            text = (repo / f).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for tag in offenders(text):
            current.add(f)

    bpath = repo / BASELINE
    if not bpath.exists():
        print(f"::error::基线文件读不到: {BASELINE}", file=sys.stderr)
        return 2
    known = {l.strip() for l in bpath.read_text(encoding="utf-8").split("\n")
             if l.strip() and not l.startswith("#")}

    new = sorted(current - known)
    print(f"scanned {len(files)} tracked Dockerfile(s); "
          f"{len(current)} still use a fully-floating base image; baseline lists {len(known)}")
    if new:
        for f in new:
            print(f"::error file={f}::基础镜像 tag 是 `:latest` 或缺失 —— "
                  f"改成精确版（`oven/bun:1.3.14`）或 `@sha256:` 钉死。"
                  f"本仓最主流的一个（26 处在用）："
                  f"oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4")
        return 1
    gone = sorted(known - current)
    if gone:
        print(f"note: baseline 里有 {len(gone)} 个已修好，可以从 {BASELINE} 删掉：")
        for f in gone:
            print(f"  - {f}")
    print("no new fully-floating base image.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
