#!/usr/bin/env python3
"""给 `promote to latest` 的 must_contain 输入挑一个**有判别力**的候选串。

## 为什么需要它

`promote-latest.yml` 会对 `npm pack` 出来的 tarball 断言
`grep -rq -- '<must_contain>' package/`,用来防 2026-08-27 那次失误
(窗口过了、ACK 有了,但推的版本**不含当晚的成果**)。

🔴 但**最自然的填法会失败**。2026-08-31 实测 `@sleep2agi/agent-node@2.5.0-preview.57`:

    resolveGrokCopresenceHubStatus   ❌ 不在字节里   ← #1548 修复的核心函数名
    inboxDeliveryPolicy              ❌ 不在字节里
    GROK_COPRESENCE                  ✅ 但 .34 里也有 —— **零判别力**
    2.5.0-preview.57                 ✅ 只证明"版本对",不证明"含新成果"

局部函数名被 bundler 压掉,只有字符串常量/env 名幸存。
一个想推某个修复的人填了函数名,会拿到 `::error:: '…' 不在字节里` ——
**读起来像"版本有问题",实际是"候选串选错了"**,于是 promote 又被搁置。

## 判据:两侧都验

只看"新版有"不够。候选必须 **旧版 miss 且新版 HIT** —— 那才叫判别力。
本工具对两个 tarball 求可打印字符串差集,再用**门自己的那行 grep** 复核。

## 排除两类,否则这道防线形同虚设

  - 依赖库的串(`undici:client:sendHeaders` / `Access-Control-Max-Age` / `wasm_*`)
    —— 只证明依赖升级了,不证明我们的改动在里面
  - 测试夹具串(`tok_desktop_test` / `tok_schema_probe`)—— 不是产品代码

用法:
    python3 scripts/suggest-must-contain.py agent-node 2.5.0-preview.34 2.5.0-preview.57
    python3 scripts/suggest-must-contain.py --selftest
"""
from __future__ import annotations
import os, re, shutil, subprocess, sys, tarfile, tempfile

SCOPE = "@sleep2agi"
# 依赖库/协议头/浏览器 API 常见形态 —— 命中这些的串没有"我们的改动"含义。
# 🔴 hint 一律写**归一化后**的形态(全小写、`_`/空格/`-` 统一成 `-`) ——
#    looks_vendor 会先归一化再比。2026-08-31 实测:我把 hint 写成 `wasm_`,
#    归一化之后**永远匹配不到**,自检当场红 —— 修一个分隔符不匹配,制造了另一个。
VENDOR_HINTS = (
    "undici", "wasm-", "sec-websocket", "access-control", "content-security",
    "cross-origin", "keep-alive", "npm-config", "node-modules", "package-lock",
    "openssl", "zlib", "http-parser", "user-agent",
    # 下面这些是 2026-08-31 用真数据(agent-network .47→.75)验出来的漏网,
    # **不是想出来的** —— 自检当时是 12/12 全绿。
    "content-transfer", "content-disposition", "transfer-encoding",
    "connection-keep-alive", "accept-encoding", "www-authenticate",
)
# 测试夹具:本仓测试里造的假 token / 探针名。
FIXTURE_RE = re.compile(r"^(tok|utok|ntok)_|_(probe|fixture|dummy)\b", re.I)
STR_RE = re.compile(r"""["']([ -~]{16,70})["']""")
CLEAN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 ,.:;()/_@-]+$")


def clean_strings(root: str) -> set[str]:
    out: set[str] = set()
    for dp, _, fs in os.walk(root):
        for f in fs:
            try:
                b = open(os.path.join(dp, f), "rb").read().decode("utf-8", "replace")
            except OSError:
                continue
            for m in STR_RE.finditer(b):
                s = m.group(1)
                if any(c in s for c in "${}`\\"):
                    continue
                if not CLEAN_RE.match(s):
                    continue
                if len(re.findall(r"[A-Za-z]{3,}", s)) < 3:
                    continue
                out.add(s)
    return out


def looks_vendor(s: str) -> bool:
    # 🔴 归一化分隔符再比:实测 `CONNECTION_KEEP_ALIVE` 曾漏网,因为 hint 写的是
    #    `keep-alive`(连字符小写)而串里是下划线大写。**hint 是概念,不是字面量。**
    low = re.sub(r"[_\s-]+", "-", s.lower())
    return any(h in low for h in VENDOR_HINTS)


def looks_fixture(s: str) -> bool:
    return bool(FIXTURE_RE.search(s))


def fetch(pkg: str, version: str, dest: str) -> str:
    """npm pack 一个版本并解开,返回 package/ 的路径。"""
    os.makedirs(dest, exist_ok=True)
    r = subprocess.run(["npm", "pack", f"{SCOPE}/{pkg}@{version}"],
                       cwd=dest, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"::error::npm pack {SCOPE}/{pkg}@{version} 失败:\n{r.stderr.strip()[:400]}")
    tgz = [f for f in os.listdir(dest) if f.endswith(".tgz")]
    if len(tgz) != 1:
        raise SystemExit(f"::error::期望恰好 1 个 .tgz,实际 {len(tgz)} 个 —— dest 没清干净?")
    with tarfile.open(os.path.join(dest, tgz[0])) as t:
        t.extractall(dest)          # noqa: S202 — npm registry tarball
    pkgdir = os.path.join(dest, "package")
    if not os.path.isdir(pkgdir):
        raise SystemExit("::error::tarball 里没有 package/ —— 布局变了?")
    return pkgdir


def gate_grep(needle: str, root: str) -> bool:
    """用 promote-latest.yml 那一行的**原形**复核,不自造判据。

    🔴 它用的是 `grep -rq --`(正则 grep),不是 `-F`。所以这里也不能加 -F,
       否则我验的和门跑的不是同一件事。
    """
    return subprocess.run(["grep", "-rq", "--", needle, root + "/"],
                          capture_output=True).returncode == 0


def suggest(pkg: str, old: str, new: str, limit: int = 12) -> list[str]:
    tmp = tempfile.mkdtemp(prefix="mustcontain-")
    try:
        a = clean_strings(fetch(pkg, old, os.path.join(tmp, "old")))
        b = clean_strings(fetch(pkg, new, os.path.join(tmp, "new")))
        only = sorted(b - a, key=len)
        keep = [s for s in only if not looks_vendor(s) and not looks_fixture(s)]
        print(f"干净串: {old}={len(a)}  {new}={len(b)}  只在新版={len(only)}  "
              f"去掉依赖/夹具后={len(keep)}")
        if not keep:
            print("::error::没有可用候选 —— 两版之间没有新的产品字符串。"
                  "这本身值得查:是不是选错了版本对?")
            return []
        oldroot = os.path.join(tmp, "old", "package")
        newroot = os.path.join(tmp, "new", "package")
        good = []
        for s in keep:
            if len(good) >= limit:
                break
            # 🔴 两侧都验:旧版必须 miss、新版必须 HIT。只验新版会选出零判别力的串。
            if not gate_grep(s, oldroot) and gate_grep(s, newroot):
                good.append(s)
        for s in good:
            print(f"  ✅ {s}")
        return good
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def selftest() -> int:
    ok = fail = 0

    def ck(name, cond):
        nonlocal ok, fail
        if cond:
            ok += 1
        else:
            fail += 1
            print(f"  ✗ {name}")

    ck("依赖串被排除", looks_vendor("undici:client:sendHeaders"))
    ck("协议头被排除", looks_vendor("Access-Control-Max-Age"))
    ck("wasm 被排除", looks_vendor("wasm_on_message_complete"))
    # 🔴 结构性防线,不靠记性:hint 若含 `_`/空格,归一化后**永不匹配**,
    #    而它失效时不会有任何东西报错(只是多放几个依赖串进候选)。
    #    实测:我修 `wasm_` 时漏了 `npm_config` / `node_modules`,靠"计数少了 1 个
    #    而不是 2 个"才追出来 —— 那是运气,这条才是防线。
    bad_hints = [h for h in VENDOR_HINTS if "_" in h or " " in h or h != h.lower()]
    ck(f"hint 全是归一化形态(违规: {bad_hints})", not bad_hints)
    # 🔴 这两条来自真数据漏网,不是想出来的
    ck("下划线大写的协议常量被排除", looks_vendor("CONNECTION_KEEP_ALIVE"))
    ck("content-transfer-encoding 被排除", looks_vendor("content-transfer-encoding"))
    ck("夹具 token 被排除", looks_fixture("tok_desktop_test"))
    ck("夹具 probe 被排除", looks_fixture("tok_schema_probe"))
    ck("真候选不被排除", not looks_vendor("anet_bin_identity") and not looks_fixture("anet_bin_identity"))
    ck("真候选不被排除2", not looks_vendor("can_create_nodes") and not looks_fixture("can_create_nodes"))
    ck("真候选不被排除3", not looks_vendor("blocked-age-unknown") and not looks_fixture("blocked-age-unknown"))
    # 取集正控:解析器真的能从一段 JS 里抽出串
    d = tempfile.mkdtemp()
    try:
        open(os.path.join(d, "x.js"), "w").write('const a="children_map_alias_mismatch";const b=`${x}`;')
        got = clean_strings(d)
        ck("抽得出普通串", "children_map_alias_mismatch" in got)
        ck("模板串被跳过", not any("${" in s for s in got))
    finally:
        shutil.rmtree(d, ignore_errors=True)
    # 判据正控:gate_grep 用的是门的原形
    d2 = tempfile.mkdtemp()
    try:
        os.makedirs(os.path.join(d2, "package"))
        open(os.path.join(d2, "package", "f.js"), "w").write("anet_bin_identity")
        ck("gate_grep 命中", gate_grep("anet_bin_identity", os.path.join(d2, "package")))
        ck("gate_grep 不误命中", not gate_grep("no_such_marker_xyz", os.path.join(d2, "package")))
    finally:
        shutil.rmtree(d2, ignore_errors=True)
    print(f"selftest: {ok} passed, {fail} failed")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    if len(sys.argv) != 4:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(0 if suggest(sys.argv[1], sys.argv[2], sys.argv[3]) else 1)
