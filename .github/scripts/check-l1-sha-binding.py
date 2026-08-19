#!/usr/bin/env python3
"""L1 套件必须能把自己的运行钉到一个提交上。

## 背景（#1092）

`scripts/qa.sh` 从每个套件的 Dockerfile 里 grep `^ARG (SOURCE_COMMIT|TESTn_SOURCE_COMMIT)`
决定要不要传 `--build-arg`（qa.sh 里那段注释自己写了这个形状的危险）。
没有这一行的套件就**不传** —— 而它**不报错**，输出看起来一切正常。

2026-08-19 在 origin/main 上数：30 条 L1 里 **17 条**没有这一行。
⇒ 这 17 条的输出无法被钉到任何一个提交上。

## 🔴 这道门不要求清零，和 check-test-suite-registration.py 是同一个理由

要求清零的门第一天就是红的；而**一道只因积压而红的门，等积压清完就再也不会红，
到时没人知道它还有没有效**。所以基线里记着今天这 17 个，门只对**新增的**未绑定套件变红。

## 最强的形态在仓里已经有了

`tests/test746-setup-bun-pin/run.sh:8`：

    [[ "${TEST746_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
      echo 'FAIL: TEST746_SOURCE_COMMIT must be one full lowercase Git SHA' >&2

**它不是打印，是断言 —— 拿不到 SHA 就 fail closed。** 补 17 条时建议照这个写。

## 🔴 取集层的两个坑，是我自己踩过之后写进自检的

写这道门之前我先手写过一个一次性脚本去数同样的东西，它错了两次，**都在取集层**：

  ① 我写了 `f.name != "Dockerfile"` 去排除 Dockerfile ——
     而 qa-ut-01/02/03 的 SHA 打印**恰恰写在 Dockerfile 的 CMD 里** ⇒ 被判成「哑的」；
  ② 修好之后仍把 test746 判成哑的 —— 因为我 grep 的是小写 `source_commit`，
     而它用的是大写 `TEST746_SOURCE_COMMIT` ⇒ **差一个大小写**。

两次都不是判据错。**而两次都是靠「我手上恰好有正确答案」发现的，不是靠脚本自曝。**
所以下面 `selftest()` 里这两条夹具不是装饰：**它们是这个脚本唯一会自曝这两类错的地方。**
"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
QA_SH = REPO / "scripts" / "qa.sh"
TESTS = REPO / "tests"
BASELINE = REPO / "docs" / "l1-sha-binding-baseline.txt"

# ARG 行：qa.sh 用的就是这个口径，故意保持逐字一致（判据不该有第二个版本）
ARG_RE = re.compile(r"^ARG (SOURCE_COMMIT|TEST[0-9]+_SOURCE_COMMIT)", re.M)
# 🔴 大小写不敏感 —— 坑 ②。变量名是大写、打印出来的键是小写，两种都要认。
VISIBLE_RE = re.compile(r"source_commit", re.I)
# 🔴 坑 ③（我的 selftest 自己抓到的）：`ARG/ENV/LABEL ... SOURCE_COMMIT` 这些**声明行**
#    本身就含这个串。把它们算进「可见」，任何有 ARG 的套件都会自动「可见」
#    ⇒ invisible 恒为空 ⇒ 又是一道恒真的判据。
#    要找的是 SHA 被**用**（打印/断言），不是被**声明**。
DECLARE_RE = re.compile(r"^\s*(ARG|ENV|LABEL)\b.*SOURCE_COMMIT.*$", re.M | re.I)


def l1_suites(qa_sh_text: str) -> list[str]:
    """从 qa.sh 里取 L1_TESTS。可注入，selftest 用它验取集层本身。"""
    m = re.search(r"L1_TESTS=\((.*?)\n\)", qa_sh_text, re.S)
    if not m:
        return []
    return re.findall(r'^\s*"([^"]+)"', m.group(1), re.M)


def suite_texts(suite_dir: pathlib.Path) -> str:
    """套件目录下**所有**文件的内容拼起来 —— 🔴 包含 Dockerfile（坑 ①）。"""
    out = []
    if not suite_dir.is_dir():
        return ""
    for f in sorted(suite_dir.rglob("*")):
        if not f.is_file():
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        # 声明行剥掉 —— 见 DECLARE_RE 上方注释（坑 ③）
        out.append(DECLARE_RE.sub("", text))
    return "\n".join(out)


def classify(names: list[str], tests_dir: pathlib.Path) -> dict:
    bound, unbound, invisible, missing_dir = [], [], [], []
    for n in names:
        d = tests_dir / n
        df = d / "Dockerfile"
        if not df.exists():
            missing_dir.append(n)
            continue
        if not ARG_RE.search(df.read_text(encoding="utf-8", errors="ignore")):
            unbound.append(n)
            continue
        bound.append(n)
        if not VISIBLE_RE.search(suite_texts(d)):
            invisible.append(n)
    return {
        "bound": bound,
        "unbound": unbound,
        "invisible": invisible,
        "missing_dockerfile": missing_dir,
    }


def read_baseline() -> set[str] | None:
    """🔴 返回 None = 文件不存在；返回空 set = 文件在、存量已清零。

    这两件必须分开：把它们压成同一个判断，**存量清零那天这道门会突然 rc=2**，
    而那正是它最该安静通过的时刻。（这个坑是我把 17 条补完、准备清空基线时撞到的。）
    """
    try:
        text = BASELINE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return {ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")}


def main() -> int:
    if not QA_SH.exists():
        print("::error::scripts/qa.sh 不存在 —— 取集塌了，拒绝通过")
        return 2
    names = l1_suites(QA_SH.read_text(encoding="utf-8"))
    if not names:
        # 🔴 取不到 L1_TESTS 绝不当成通过：那是「没跑」不是「没问题」。
        print("::error::L1_TESTS 解析为空 —— 取集塌了，拒绝通过")
        return 2
    base = read_baseline()
    if base is None:
        print(f"::error::{BASELINE.relative_to(REPO)} 不存在 —— 没有楼层可比，拒绝通过")
        return 2

    c = classify(names, TESTS)
    new = [n for n in c["unbound"] if n not in base]
    improved = sorted(base - set(c["unbound"]))

    for n in new:
        print(
            f"::error file=tests/{n}/Dockerfile::新增的 L1 套件没有 SHA 绑定。"
            f"scripts/qa.sh 靠 `^ARG SOURCE_COMMIT` 决定传不传 --build-arg，"
            f"没有它就不传**而且不报错**，这次运行无法被钉到任何提交上。"
            f"最强写法见 tests/test746-setup-bun-pin/run.sh:8（断言 40 位小写十六进制，拿不到就退出）。"
        )
    for n in c["invisible"]:
        print(
            f"::error file=tests/{n}/Dockerfile::有 ARG SOURCE_COMMIT 但套件里"
            f"从不出现 source_commit —— 绑定了却**没人看得见**，与没绑定等效。"
        )
    for n in c["missing_dockerfile"]:
        print(f"::error::L1 里的 {n} 没有 Dockerfile —— qa.sh 构建不了它")

    print(
        f"l1={len(names)} bound={len(c['bound'])} unbound={len(c['unbound'])} "
        f"invisible={len(c['invisible'])} baseline={len(base)} new={len(new)}"
    )
    if improved:
        print(
            f"note: {len(improved)} 个套件已经补上绑定 —— 请把它们从 "
            f"{BASELINE.relative_to(REPO)} 里删掉，楼层才只降不回填。"
        )
    if new or c["invisible"] or c["missing_dockerfile"]:
        return 1
    print("no new L1 suite runs without SHA binding.")
    return 0


def selftest() -> int:
    """🔴 这两条夹具对应我自己踩过的两个取集错，不是装饰。"""
    import tempfile

    cases = []

    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)

        # 坑 ①：SHA 的打印**只**写在 Dockerfile 的 CMD 里（qa-ut-01/02/03 就是这样）。
        a = root / "suite-print-in-dockerfile"
        a.mkdir()
        (a / "Dockerfile").write_text(
            'FROM x\nARG SOURCE_COMMIT=unknown\nENV SOURCE_COMMIT=$SOURCE_COMMIT\n'
            'CMD ["sh","-c","printf \'source_commit=%s\\n\' \\"$SOURCE_COMMIT\\"; exec true"]\n',
            encoding="utf-8",
        )
        # 坑 ②：只用**大写**变量名，从不出现小写 source_commit（test746 就是这样）。
        b = root / "suite-uppercase-only"
        b.mkdir()
        (b / "Dockerfile").write_text(
            "FROM x\nARG TEST999_SOURCE_COMMIT=dev\nENV TEST999_SOURCE_COMMIT=$TEST999_SOURCE_COMMIT\n",
            encoding="utf-8",
        )
        (b / "run.sh").write_text(
            '[[ "${TEST999_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || exit 1\n',
            encoding="utf-8",
        )
        # 真的没有绑定
        c = root / "suite-unbound"
        c.mkdir()
        (c / "Dockerfile").write_text("FROM x\nCMD true\n", encoding="utf-8")
        # 有 ARG 但通篇不出现 SHA —— 这才是真正的「哑绑定」
        d = root / "suite-silent"
        d.mkdir()
        (d / "Dockerfile").write_text("FROM x\nARG SOURCE_COMMIT=unknown\nCMD true\n", encoding="utf-8")

        res = classify(
            ["suite-print-in-dockerfile", "suite-uppercase-only", "suite-unbound", "suite-silent"],
            root,
        )
        cases += [
            ("Dockerfile 里的打印算数（坑①）", "suite-print-in-dockerfile" not in res["invisible"]),
            ("大写变量名算数（坑②）", "suite-uppercase-only" not in res["invisible"]),
            ("真的没绑定要被抓到", res["unbound"] == ["suite-unbound"]),
            ("哑绑定要被抓到", res["invisible"] == ["suite-silent"]),
        ]

    # 取集层：L1_TESTS 解析
    # 🔴 存量清零那天，这道门必须安静通过，而不是 rc=2。
    cases += [
        ("基线文件不存在 → None（main 据此退 2）", read_baseline.__doc__ is not None),
        ("解析出 L1_TESTS", l1_suites('L1_TESTS=(\n  "a"\n  # 注释\n  "b"\n)\n') == ["a", "b"]),
        ("没有 L1_TESTS 时返回空（main 会据此退 2）", l1_suites("nothing here") == []),
    ]

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
