#!/usr/bin/env python3
"""已发布的 npm 产物里不许内联构建机的绝对路径。见 #732。

🔴 为什么裸 grep 在这里不作数
=============================

`agent-network` 的 build 最后一步是:

    npx javascript-obfuscator dist/bin/cli.js --output dist/bin/cli.js \\
        --compact true --string-array true --string-array-encoding base64

**所有字符串都躺在一张 base64 编码的字符串表里。** 对这样的产物
`grep '/home/'` 得到 0 —— 而那个 0 的含义是「没有那个**形状**」,不是「没有那件事」。

2026-08-18 实测:`agent-network@2.2.21` 的字符串表有 **4337 条 / 320,711 字节**。
第一次查的时候我就是裸 grep 拿到 0,差点报「没有泄漏」。

所以这道门查三层:

    ① 全文件裸字节                 /home/<name>/ /Users/<name>/ /root/ .nvm
    ② base64 三相位片段            对探针前面补 0/1/2 字节再编码，取中段子串
                                   —— 绕开 base64 的对齐问题
    ③ 抠出混淆器字符串表逐条解码    最硬的一层；也是唯一能抓住 base64 藏匿的一层

🔴 分母承重
===========

- 取不到产物            → exit 2（不是 exit 0）
- 一个文件都没扫到       → exit 2
- **产物看起来被混淆了(存在 `a0_0x` 之类的标识)，但一条字符串表条目都没解出来**
  → exit 2。这一条是「量具接上了没有」的自检:解不出来时,第三层等于没跑,
  而它没跑和它跑完没发现,打印出来会长得一样。

用法
====

    python3 .github/scripts/check-published-build-paths.py <pkg>@<tag> [<pkg>@<tag> ...]
    python3 .github/scripts/check-published-build-paths.py --selftest
"""
from __future__ import annotations

import base64
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# 只认「像真人家目录」的形态;/home/runner 这类 CI 账号不算泄漏。
NOT_A_PERSON = {"user", "username", "example", "ubuntu", "root", "runner", "node", "ci", "test"}
PERSON_PATH = re.compile(r"/(?:home|Users)/([A-Za-z0-9._-]+)/")
OTHER_MARKS = (".nvm/versions/node/", "/root/.bun/")
OBFUSCATED = re.compile(r"a0_0x[0-9a-f]{4,}|_0x[0-9a-f]{4,}")
# 🔴 阈值是「多少条字面量才算一张字符串表」。它不是随手写的:
#    定太低 → 把源码里每个普通数组都当字符串表去解，噪音大且慢；
#    定太高 → selftest 造不出真实的最小夹具，等于这一层没被测过。
#    8 条是折中。**已知边界:一条藏在少于 8 条字面量的数组里的路径，第三层抓不到**
#    —— 那种形态不是混淆器产生的（混淆器只产一张大表），而是有人手动藏的，
#    第 ①② 层对未编码/错位的形态仍然覆盖。这一格如实写在这里，不假装它不存在。
STRING_ARRAY = re.compile(r"=\s*\[((?:\s*'(?:[^'\\]|\\.)*'\s*,?){8,})\]", re.S)
LITERAL = re.compile(r"'((?:[^'\\]|\\.)*)'")

# 🔴 严格模式抓不全。实测:对 agent-network@2.2.21，上面那条只解出 **102** 条，
#    而这个产物的字符串表实际有 **4337** 条 —— 第三层在 ~2% 的覆盖率上报了
#    「0 findings」。差别在于严格模式要求数组里**每一个**元素都是简单单引号
#    字面量，遇到第一个不合形的就停下。
#    所以再加一条按混淆器函数签名抓整段的模式，两者取并集。
OBF_ARRAY_FN = re.compile(
    r"function\s+a0_0x[0-9a-f]+\s*\(\s*\)\s*\{\s*const\s+_0x[0-9a-f]+\s*=\s*\[(.*?)\]\s*;",
    re.S)


def person_hits(text: str) -> list[str]:
    out = []
    for m in PERSON_PATH.finditer(text):
        if m.group(1) not in NOT_A_PERSON:
            out.append(m.group(0))
    for mark in OTHER_MARKS:
        if mark in text:
            out.append(mark)
    return out


def b64_probes() -> set[str]:
    probes = set()
    for raw in (b"/home/", b"/Users/", b".nvm/versions"):
        for pad in (b"", b"x", b"xx"):
            enc = base64.b64encode(pad + raw).decode()
            core = enc[2:-2]
            if len(core) >= 6:
                probes.add(core)
    return probes


def string_array_entries(text: str) -> tuple[list[str], int]:
    """→ (可检查的字符串, 字符串表条目总数)

    🔴 返回的字符串里**同时包含原文和解码结果**。
       只看解码结果会漏掉「路径没被编码、直接躺在表里」的形态;
       只看原文会漏掉 base64 藏匿。两种都要。

    🔴 第二个返回值是**条目总数**,不是解码成功数。实测:agent-network@2.2.21
       的表有 4337 条,而其中只有 ~204 条能 base64 解成合法 UTF-8 —— 其余本来
       就不是 base64。拿「解码成功数」当覆盖率下限会把一次正常的扫描判成失败,
       我第一版就是这么写的。
    """
    out: list[str] = []
    total = 0
    # 🔴 去重:两条模式会匹配到**同一段**数组体（严格模式和函数签名模式都能命中
    #    混淆器那张大表），不去重的话条目会被数两遍 —— 实测 4582 → 9164。
    #    一个被虚报成两倍的覆盖率数字，会让下面那条下限失去意义。
    bodies = list(dict.fromkeys(list(STRING_ARRAY.findall(text)) + list(OBF_ARRAY_FN.findall(text))))
    for body in bodies:
        for lit in LITERAL.findall(body):
            total += 1
            out.append(lit)
            try:
                out.append(base64.b64decode(lit + "=" * (-len(lit) % 4)).decode("utf-8"))
            except Exception:
                continue
    return out, total


def scan_tree(root: Path) -> tuple[list[str], int, int, int]:
    """→ (findings, files_scanned, obfuscated_files, decoded_strings)"""
    findings: list[str] = []
    files = obf = decoded = 0
    probes = b64_probes()
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        files += 1
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = str(p.relative_to(root))
        for h in person_hits(text):
            findings.append(f"{rel}: 裸命中 «{h}»")
        for pr in probes:
            if pr in text:
                findings.append(f"{rel}: base64 相位片段命中 «{pr}»")
        if OBFUSCATED.search(text[:4000]):
            obf += 1
            entries, total = string_array_entries(text)
            decoded += total
            for d in entries:
                for h in person_hits(d):
                    findings.append(f"{rel}: 字符串表里命中 «{h}»")
    return findings, files, obf, decoded


def check_package(spec: str) -> int:
    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        r = subprocess.run(["npm", "pack", "--prefer-online", spec],
                           cwd=work, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"FAIL[{spec}]: npm pack 失败 —— 这一轮什么都没验，不当作通过", file=sys.stderr)
            print((r.stderr or "")[-400:], file=sys.stderr)
            return 2
        tgz = next(iter(work.glob("*.tgz")), None)
        if tgz is None:
            print(f"FAIL[{spec}]: npm pack 没产出 tgz", file=sys.stderr)
            return 2
        with tarfile.open(tgz) as tf:
            tf.extractall(work / "x", filter="data")
        findings, files, obf, decoded = scan_tree(work / "x")

    print(f"[{spec}] scanned {files} file(s); {obf} look obfuscated; "
          f"{decoded} string-array entrie(s) inspected; {len(findings)} finding(s)")
    if files == 0:
        print(f"FAIL[{spec}]: 一个文件都没扫到 —— 取集塌了", file=sys.stderr)
        return 2
    # 🔴 量具自检:看着像混淆产物，却一条都没解出来 ⇒ 第三层等于没跑。
    # 🔴 量具自检。`decoded > 0` 这个门槛太低 —— 实测它在 102/4337（≈2% 覆盖率）
    #    的情况下照样放行，而那一轮的「0 findings」几乎没有信息量。
    #    混淆产物的字符串表是成千上万条量级。这里数的是**条目总数**（不是解码成功数——
    #    实测 4337 条里只有 ~204 条是合法 base64 UTF-8），下限取每个混淆文件 200 条。
    MIN_DECODED_PER_OBF_FILE = 200
    if obf > 0 and decoded < obf * MIN_DECODED_PER_OBF_FILE:
        print(f"FAIL[{spec}]: {obf} 个文件看起来被混淆了，但只取到 {decoded} 条字符串表条目 "
              f"(下限 {obf * MIN_DECODED_PER_OBF_FILE}) —— 第三层没接上或只接上一部分，"
              f"本轮的『无发现』不作数", file=sys.stderr)
        return 2
    for f in findings:
        print(f"::error::[{spec}] {f}")
    return 1 if findings else 0


def selftest() -> int:
    cases = []

    def ck(name, ok, detail=""):
        cases.append((name, ok, detail))

    ck("裸路径被抓", bool(person_hits("const p = '/home/someone/build/x';")))
    ck("CI 账号不算泄漏", not person_hits("/home/runner/work/repo/x"))
    ck("占位名不算泄漏", not person_hits("/home/user/project"))
    ck("nvm 路径被抓", bool(person_hits("/opt/.nvm/versions/node/v20/bin")))

    # 🔴 最关键的一条:把路径藏进 base64 字符串表，裸 grep 必然 0，第三层必须抓住。
    hidden = base64.b64encode(b"/home/someone/build/cli.ts").decode()
    # 夹具要造成**真实的最小字符串表**（≥ STRING_ARRAY 的阈值），否则这一层根本
    # 不会被触发 —— 第一版我只放了 2 条，selftest 当场把我自己抓了出来。
    filler = ",".join("'%s'" % base64.b64encode(b"pad%d" % i).decode() for i in range(10))
    fake = "const a0_0x1234=a0_0x5b14;var _0x1=['%s',%s];" % (hidden, filler)
    ck("裸 grep 对 base64 藏匿必然漏", not person_hits(fake))
    entries, total = string_array_entries(fake)
    ck("字符串表里抓住它（解码后）", any(person_hits(d) for d in entries))
    ck("条目总数被数到（覆盖率下限靠它）", total >= 11, f"total={total}")
    ck("能认出这是混淆产物", bool(OBFUSCATED.search(fake)))

    for n, ok, d in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}   {d}")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    specs = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not specs:
        print("usage: check-published-build-paths.py <pkg>@<tag> [...]", file=sys.stderr)
        return 2
    worst = 0
    for s in specs:
        worst = max(worst, check_package(s))
    return worst


if __name__ == "__main__":
    sys.exit(main())
