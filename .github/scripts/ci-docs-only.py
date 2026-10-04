#!/usr/bin/env python3
"""只改 docs-site/ 的 PR,走 qa.yml 的轻量路径。

## 为什么

下载页 bump(docs-site/docs/index.md + en/index.md + public/desktop/update/fallback.json,
例如 #2202/#2204/#2205/#2206)也会触发 qa.yml 的全部 ~100 个检查 —— L0+L1 单 job
就 15 分钟,加上排队,一个 3 文件的文档 PR 要 33–41 分钟才可合,拖住每一次 app 发版。

## 做法(两层,分开自检 —— CLAUDE.md 复核纪律 ⑤)

**取集**(`collect`):pull_request 事件里 actions/checkout 检出的是
`refs/pull/N/merge` —— CI 真正测的那棵树。它的第一个父提交就是 base 分支当前的尖。
所以 `git diff --no-renames HEAD^1 HEAD` 恰好等于「这次合并会让 main 变化的文件」:

  - `--no-renames`:改名拆成「删旧路径 + 加新路径」,两个路径**都**进集合
    (`server/x.ts → docs-site/x.md` 必须走全量,旧路径在 server/ 下);
  - 删除的文件照样列出;
  - 嵌套目录不需要任何递归逻辑 —— git 给的是完整路径;
  - `-z`:路径里有空格/换行也不会切错。

HEAD 不是双亲合并提交(push 事件、手动检出)→ 取不到 → **全量**。

**判据**(`classify`):集合非空,且每一条路径都在 `docs-site/` 下 → docs-only。
其他任何情况(空集合、一个文件在外面、路径不规整)→ **全量**。

## docs-only 时跳什么、不跳什么

不是「docs-only 就全跳」—— 有一批套件的镜像里**就有** docs-site(下载页、版本声明、
文档里的契约断言),它们恰恰是文档 PR 该跑的。判据是机械的:

    一个 Docker 套件可以跳过  ⇔  它的 Dockerfile 从构建上下文拷进镜像的东西里
                                    不可能包含 docs-site/ 下的任何文件

`COPY . …`、`COPY docs-site …`、`COPY .git …`、首段带通配符且能匹配 docs-site 的源、
看不懂的形状 —— 一律算「看得见」,照跑。这个判据只会**多跑**,不会少跑。

三种落点:
  1. `SKIPPABLE_JOBS`(下表):整 job 跳过(job 级 `if:`)。表是手写的,但每次运行都**校验**:
     job 真的存在、它构建的 Dockerfile 集合与表里逐字相同、没有一个看得见 docs-site、
     job 上真的挂着对应的 `if:`。任何一条不符 → 本脚本红(而下游 job 照跑全量)。
  2. `MATRIX_JOBS`:矩阵里逐个套件判,跳过的那格所有 step 变 no-op(矩阵上下文在 job 级
     `if:` 里拿不到)。
  3. `qa` job 的 L1:用 `scripts/qa.sh --list` 取 L1 清单(调产品自己的取集,不重写),
     只把看得见 docs-site 的套件通过 `QA_L1_ONLY` 交给 qa.sh。L0 照跑(2 秒)。

## 失败方向

下游 job 的 `if:` 写成 `!cancelled() && !contains(needs.changes.outputs.skip, '"job:<id>"')`:
本脚本红了、输出为空 → `contains` 为假 → **全部照跑**。跳过只发生在本脚本完整跑完、
明确写出某个 token 的时候。

用法:
    python3 .github/scripts/ci-docs-only.py --selftest
    python3 .github/scripts/ci-docs-only.py plan  >> "$GITHUB_OUTPUT"
    python3 .github/scripts/ci-docs-only.py verify          # 只校验表,不取集

退出码:0 正常(含「全量」结论) / 1 表与 qa.yml 不符或自检失败
"""
from __future__ import annotations

import fnmatch
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DOCS_PREFIX = "docs-site/"
QA_YML = ".github/workflows/qa.yml"

# job id → 它构建的 tests/<suite>/Dockerfile。docs-only 时整 job 跳过。
# 只收「纯 docker build/run」的 job(宿主上只做 checkout / 上传产物 / 读容器报告)。
# 宿主上执行仓库代码的 job(test-lib-meta、windows-codex-copresence、qa)不在表里。
SKIPPABLE_JOBS: dict[str, set[str]] = {
    "doc-claims": {"test846-doc-claims"},
    "agent-network-unit": {"test745-agent-network-unit-ci", "test505-tmux-socket-isolation"},
    "server-unit": {"test798-server-unit-ci"},
    "agent-node-unit": {"test725-agent-node-unit-ci"},
    "test1755-rules-file-e2e": {"test1755-rules-file-e2e"},
    "qa-node-logs-e2e": {"qa-node-logs-e2e"},
    "qa-create-node-workdir": {"qa-create-node-workdir"},
    "recovered-suites": {
        "test597-dashboard-slash-namespace", "test679-task-trace",
        "qa-daemon-lifecycle-e2e", "qa-rfc024-config-apply",
        "qa-rfc027-stop-delete", "test224-grok-preview-security",
    },
    "test225-known-failures": {"test225-grok-preview-package-live"},
    "hub-daemon-gate": {"test735-hub-daemon-rebuild"},
    "private-config-gates": {
        "test631-private-config-permissions", "test646-config-node-id-precedence",
    },
    "security-orphan-gates": {
        "test630-file-download-header-auth", "test634-windows-secret-guidance",
        "test623-feishu-scrub-health", "test30-v0.8-auth-deprecation",
        "test516-anet-secret-masking", "test516-node-delete-hub-row",
        "test522-node-delete-locate-stop",
    },
}
MATRIX_JOBS = ("grok-green-suites", "hub-boundary-gates", "hub-orphan-gates")


# ── 判据 ────────────────────────────────────────────────────────────────────

def _clean(p: str) -> bool:
    return bool(p) and not p.startswith("/") and "\\" not in p and \
        ".." not in p.split("/") and "//" not in p and not p.startswith("./")


def classify(paths: list[str]) -> tuple[bool, str]:
    """(docs_only, 理由)。只有每一条都在 docs-site/ 下才返回 True。"""
    if not paths:
        return False, "变更集合为空 —— 证明不了 docs-only,走全量"
    for p in paths:
        if not _clean(p):
            return False, f"路径不规整 {p!r},走全量"
        if not p.startswith(DOCS_PREFIX):
            return False, f"{p} 不在 {DOCS_PREFIX} 下,走全量"
    return True, f"{len(paths)} 个文件全部在 {DOCS_PREFIX} 下"


# ── 取集 ────────────────────────────────────────────────────────────────────

def collect(repo: str = ".") -> list[str]:
    """合并提交相对第一个父提交改了哪些路径。取不到就抛异常(调用方走全量)。"""
    def git(*a: str) -> str:
        return subprocess.run(["git", "-C", repo, *a], check=True,
                              capture_output=True, text=True).stdout
    parents = git("rev-list", "--parents", "-n", "1", "HEAD").split()
    if len(parents) != 3:
        raise RuntimeError(f"HEAD 有 {len(parents) - 1} 个父提交,不是 PR 合并提交")
    out = git("diff", "--no-renames", "--name-only", "-z", "HEAD^1", "HEAD")
    return sorted({p for p in out.split("\0") if p})


# ── Dockerfile 能不能看见 docs-site ──────────────────────────────────────────

def _logical_lines(text: str) -> list[str]:
    lines, cur = [], ""
    for raw in text.splitlines():
        s = raw.rstrip()
        if not cur and s.lstrip().startswith("#"):
            continue
        if s.endswith("\\"):
            cur += s[:-1] + " "
            continue
        lines.append(cur + s)
        cur = ""
    if cur:
        lines.append(cur)
    return lines


def _source_sees_docs(src: str) -> bool:
    s = src.strip().strip('"').strip("'")
    while s.startswith("./"):
        s = s[2:]
    if s in ("", ".", "/"):
        return True
    first = s.lstrip("/").split("/", 1)[0]
    if any(ch in first for ch in "*?["):
        return fnmatch.fnmatch("docs-site", first) or fnmatch.fnmatch(".git", first)
    return first in ("docs-site", ".git")


def dockerfile_sees_docs(text: str) -> tuple[bool, str]:
    """(看得见?, 依据)。看不懂的形状算看得见。"""
    for line in _logical_lines(text):
        s = line.strip()
        word = s.split(None, 1)[0].upper() if s else ""
        if word == "FROM":
            img = s.split()[1] if len(s.split()) > 1 else ""
            if img.startswith("anet") or "$" in img:
                return True, f"FROM 本地/变量镜像 {img}"
        if word == "RUN" and "type=bind" in s:
            return True, "RUN --mount=type=bind"
        if word not in ("COPY", "ADD"):
            continue
        rest = s.split(None, 1)[1] if len(s.split(None, 1)) > 1 else ""
        if rest.startswith("<<"):
            continue  # heredoc,内容写在 Dockerfile 里
        if rest.startswith("["):
            return True, f"JSON 形式 {s[:60]}"  # 本仓没有,看不懂就算看得见
        try:
            toks = shlex.split(rest)
        except ValueError:
            return True, f"解析不了 {s[:60]}"
        if any(t.startswith("--from") for t in toks):
            continue  # 来自其他阶段/镜像,其上下文内容已在那一阶段计过
        if any(t.startswith("--build-context") for t in toks):
            return True, "--build-context"
        args = [t for t in toks if not t.startswith("--")]
        for src in args[:-1]:
            if _source_sees_docs(src):
                return True, f"{word} {src}"
    return False, "没有任何 COPY/ADD 源能覆盖 docs-site/"


def suite_sees_docs(root: Path, suite: str) -> tuple[bool, str]:
    df = root / "tests" / suite / "Dockerfile"
    if not df.is_file():
        return True, f"{df} 不存在,无从证明"
    return dockerfile_sees_docs(df.read_text(encoding="utf-8"))


# ── qa.yml 校验 + 计划 ──────────────────────────────────────────────────────

def _job_text(job: dict) -> str:
    return "\n".join(str(s.get("run", "")) for s in job.get("steps") or [])


def _job_token(jid: str) -> str:
    return f'"job:{jid}"'


def verify(root: Path) -> list[str]:
    import yaml  # 只在这里需要;CI 里装 requirements-workflow-structure.txt
    wf = yaml.safe_load((root / QA_YML).read_text(encoding="utf-8"))
    jobs = wf.get("jobs") or {}
    bad: list[str] = []
    for jid, suites in SKIPPABLE_JOBS.items():
        job = jobs.get(jid)
        if job is None:
            bad.append(f"表里的 job {jid} 不在 qa.yml 里")
            continue
        refs = set(re.findall(r"tests/([\w.-]+)/Dockerfile", _job_text(job)))
        if refs != suites:
            bad.append(f"{jid}: 构建的 Dockerfile {sorted(refs)} ≠ 表 {sorted(suites)}")
        for s in sorted(refs | suites):
            sees, why = suite_sees_docs(root, s)
            if sees:
                bad.append(f"{jid}: {s} 看得见 docs-site({why}),不能整 job 跳过")
        cond = str(job.get("if", ""))
        if _job_token(jid) not in cond or "!cancelled()" not in cond:
            bad.append(f"{jid}: job 级 if 没挂 {_job_token(jid)} / !cancelled()")
        if "changes" not in (job.get("needs") or []):
            bad.append(f"{jid}: 缺 needs: changes")
    for jid in MATRIX_JOBS:
        job = jobs.get(jid)
        if job is None:
            bad.append(f"矩阵 job {jid} 不在 qa.yml 里")
            continue
        suites = ((job.get("strategy") or {}).get("matrix") or {}).get("suite")
        if not isinstance(suites, list) or not suites:
            bad.append(f"{jid}: 取不到 matrix.suite 列表")
        for i, st in enumerate(job.get("steps") or []):
            cond = str(st.get("if", ""))
            if cond.strip() == "failure()":
                continue  # 只在失败时跑,跳过的格不会失败
            if '"suite:{0}"' not in cond:
                bad.append(f"{jid}: 第 {i} 个 step 没挂 suite 跳过条件")
        if "changes" not in (job.get("needs") or []):
            bad.append(f"{jid}: 缺 needs: changes")
    return bad


def matrix_suites(root: Path) -> dict[str, list[str]]:
    import yaml
    wf = yaml.safe_load((root / QA_YML).read_text(encoding="utf-8"))
    return {j: list(wf["jobs"][j]["strategy"]["matrix"]["suite"]) for j in MATRIX_JOBS}


def l1_suites(root: Path) -> list[str]:
    out = subprocess.run(["bash", "scripts/qa.sh", "--list"], cwd=root, check=True,
                         capture_output=True, text=True).stdout
    names = re.findall(r"^\s*- tests/([\w.-]+)/\s*$", out, re.M)
    if not names:
        raise RuntimeError("qa.sh --list 没列出任何 L1 套件 —— 取集塌了")
    return names


def plan(root: Path) -> dict[str, str]:
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    try:
        if event and event != "pull_request":
            # push 到 main 时 HEAD 也可能是双亲合并提交;轻量路径只给 PR,main 永远全量。
            raise RuntimeError(f"事件是 {event},不是 pull_request")
        paths = collect(str(root))
        docs_only, why = classify(paths)
    except Exception as e:  # noqa: BLE001 —— 任何取集失败都走全量
        paths, docs_only, why = [], False, f"取集失败({e}),走全量"
    print(f"变更文件 {len(paths)} 个:", file=sys.stderr)
    for p in paths[:50]:
        print(f"  {p}", file=sys.stderr)
    print(f"结论: docs_only={str(docs_only).lower()} —— {why}", file=sys.stderr)
    if not docs_only:
        return {"docs_only": "false", "skip": "", "l1_only": ""}
    skip = [_job_token(j) for j in SKIPPABLE_JOBS]
    for jid, suites in matrix_suites(root).items():
        for s in suites:
            sees, reason = suite_sees_docs(root, s)
            print(f"  {jid}/{s}: {'跑' if sees else '跳'} —— {reason}", file=sys.stderr)
            if not sees:
                skip.append(f'"suite:{s}"')
    keep = []
    for s in l1_suites(root):
        sees, reason = suite_sees_docs(root, s)
        print(f"  L1/{s}: {'跑' if sees else '跳'} —— {reason}", file=sys.stderr)
        if sees:
            keep.append(s)
    # keep 为空时 QA_L1_ONLY="" ⇒ qa.sh 跑全部 L1 —— 朝安全方向错。
    return {"docs_only": "true", "skip": " ".join(skip), "l1_only": " ".join(keep)}


# ── 自检 ────────────────────────────────────────────────────────────────────

_TMP: list[str] = []


def _git(repo: str, *a: str) -> None:
    subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True)


def _write(repo: str, rel: str, body: str = "x\n") -> None:
    p = Path(repo, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body)


def _pr_merge(build_pr, advance_main=None) -> str:
    """造一个仓:base 提交 → PR 分支上 build_pr(repo) → (可选)main 前进 →
    `git merge --no-ff`,得到和 refs/pull/N/merge 同形状的双亲合并提交。"""
    repo = tempfile.mkdtemp(prefix="ci-docs-only-")
    _TMP.append(repo)
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")
    for rel in ("server/a.ts", "server/b.ts", "docs-site/docs/index.md",
                "docs-site/docs/en/index.md", "docs-site/docs/old.md", "README.md"):
        _write(repo, rel, rel + "\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "base")
    _git(repo, "checkout", "-qb", "pr")
    build_pr(repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "pr")
    _git(repo, "checkout", "-q", "main")
    if advance_main:
        advance_main(repo)
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "main moved")
    _git(repo, "merge", "-q", "--no-ff", "-m", "merge", "pr")
    return repo


def selftest() -> int:
    results: list[tuple[str, bool]] = []

    def check(name: str, ok: bool) -> None:
        results.append((name, ok))

    # 判据
    check("判据: 下载页三件套 → docs-only", classify([
        "docs-site/docs/index.md", "docs-site/docs/en/index.md",
        "docs-site/docs/public/desktop/update/fallback.json"])[0])
    check("判据: 空集合 → 全量", not classify([])[0])
    check("判据: docs-site + 一个 server 文件 → 全量",
          not classify(["docs-site/docs/index.md", "server/src/x.ts"])[0])
    check("判据: docs-site-evil/ 不是 docs-site/", not classify(["docs-site-evil/x.md"])[0])
    check("判据: 根目录同名文件 docs-site → 全量", not classify(["docs-site"])[0])
    check("判据: .. 逃逸 → 全量", not classify(["docs-site/../server/x.ts"])[0])
    check("判据: docs/ 不在白名单 → 全量", not classify(["docs/qa/strategy.md"])[0])
    check("判据: .github 改动 → 全量", not classify([".github/workflows/qa.yml"])[0])

    # Dockerfile 判据
    sees = lambda t: dockerfile_sees_docs(t)[0]  # noqa: E731
    check("DF: COPY . /app 看得见", sees("FROM x\nCOPY . /app\n"))
    check("DF: COPY ./ /app 看得见", sees("FROM x\nCOPY ./ /app\n"))
    check("DF: COPY docs-site /d 看得见", sees("FROM x\nCOPY docs-site /d\n"))
    check("DF: COPY docs-site/docs/a.md 看得见", sees("FROM x\nCOPY docs-site/docs/a.md /a\n"))
    check("DF: 续行里的 docs-site 看得见",
          sees("FROM x\nCOPY server/ \\\n     docs-site/docs/x.md \\\n     /app/\n"))
    check("DF: 多行 COPY 只拷 server 看不见(续行要真拼起来,不能靠「解析不了」蒙对)",
          not sees("FROM x\nCOPY server/a.ts \\\n     server/b.ts \\\n     /app/\n"))
    check("DF: --chown 之后的 docs-site 看得见", sees("FROM x\nCOPY --chown=1:1 docs-site /d\n"))
    check("DF: 小写 copy 看得见", sees("FROM x\ncopy docs-site /d\n"))
    check("DF: ADD . 看得见", sees("FROM x\nADD . /app\n"))
    check("DF: COPY * 看得见", sees("FROM x\nCOPY * /app/\n"))
    check("DF: COPY d* 看得见", sees("FROM x\nCOPY d* /app/\n"))
    check("DF: COPY .git 看得见", sees("FROM x\nCOPY .git /app/.git\n"))
    check("DF: JSON 形式算看得见", sees('FROM x\nCOPY ["server", "/s"]\n'))
    check("DF: bind mount 算看得见", sees("FROM x\nRUN --mount=type=bind,target=/s true\n"))
    check("DF: FROM 本地 anet 镜像算看得见", sees("FROM anet-base\nCOPY server /s\n"))
    check("DF: 只拷 server/agent-node 看不见",
          not sees("FROM x\nCOPY server/ /app/server/\nCOPY agent-node/package.json /a/\n"))
    check("DF: COPY *.json 看不见", not sees("FROM x\nCOPY *.json /app/\n"))
    check("DF: COPY --from=stage . 看不见", not sees("FROM x AS b\nFROM y\nCOPY --from=b /app /app\n"))
    check("DF: 注释里的 COPY . 不算", not sees("FROM x\n# COPY . /app\nCOPY server /s\n"))
    check("DF: docs/ 不是 docs-site", not sees("FROM x\nCOPY docs/ /d\n"))

    # 取集:真 git 仓,真合并提交
    def nested_and_delete(r):
        _write(r, "docs-site/docs/en/guide/deep/nested/page.md", "new\n")
        Path(r, "docs-site/docs/old.md").unlink()
        _write(r, "docs-site/docs/index.md", "changed\n")
        _write(r, "docs-site/docs/a b.md", "space\n")
    got = collect(_pr_merge(nested_and_delete))
    check("取集: 嵌套新增 + 删除 + 带空格路径都收进来", got == sorted([
        "docs-site/docs/en/guide/deep/nested/page.md", "docs-site/docs/old.md",
        "docs-site/docs/index.md", "docs-site/docs/a b.md"]))
    check("取集→判据: 上面这组 → docs-only", classify(got)[0])

    def rename_in(r):
        Path(r, "server/a.ts").rename(Path(r, "docs-site/docs/a.md"))
    got = collect(_pr_merge(rename_in))
    check("取集: server→docs-site 改名,两个路径都在", got == ["docs-site/docs/a.md", "server/a.ts"])
    check("取集→判据: 改名进 docs-site → 全量", not classify(got)[0])

    def rename_out(r):
        Path(r, "docs-site/docs/old.md").rename(Path(r, "server/old.md"))
    check("取集→判据: 改名出 docs-site → 全量", not classify(collect(_pr_merge(rename_out)))[0])

    def rename_within(r):
        Path(r, "docs-site/docs/new").mkdir()
        Path(r, "docs-site/docs/old.md").rename(Path(r, "docs-site/docs/new/old.md"))
    check("取集→判据: docs-site 内改名 → docs-only",
          classify(collect(_pr_merge(rename_within)))[0])

    def mixed(r):
        _write(r, "docs-site/docs/index.md", "changed\n")
        _write(r, "server/b.ts", "changed\n")
    got = collect(_pr_merge(mixed))
    check("取集: docs-site + 一个 server 文件都收进来",
          got == ["docs-site/docs/index.md", "server/b.ts"])
    check("取集→判据: docs-site + 一个 server 文件 → 全量", not classify(got)[0])

    def docs_only_edit(r):
        _write(r, "docs-site/docs/index.md", "changed\n")
    def main_touches_server(r):
        _write(r, "server/a.ts", "main moved\n")
    got = collect(_pr_merge(docs_only_edit, main_touches_server))
    check("取集: main 前进的 server 改动不算进 PR(diff 对第一个父提交)",
          got == ["docs-site/docs/index.md"])

    repo = tempfile.mkdtemp(prefix="ci-docs-only-")
    _TMP.append(repo)
    _git(repo, "init", "-q", "-b", "main")
    for i in (1, 2):  # 两个提交:HEAD^1 存在,只是 HEAD 不是合并提交
        _write(repo, "docs-site/x.md", f"{i}\n")
        _git(repo, "add", "-A")
        _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", f"c{i}")
    try:
        collect(repo)
        check("取集: 非合并提交必须抛(调用方走全量)", False)
    except Exception:  # noqa: BLE001
        check("取集: 非合并提交必须抛(调用方走全量)", True)

    for d in _TMP:
        shutil.rmtree(d, ignore_errors=True)
    fails = [n for n, ok in results if not ok]
    for n, ok in results:
        print(f"  {'ok ' if ok else 'FAIL'} {n}")
    print(f"selftest {len(results) - len(fails)}/{len(results)}")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    root = Path(os.environ.get("GITHUB_WORKSPACE") or ".").resolve()
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "--selftest":
        return selftest()
    if cmd in ("verify", "plan"):
        bad = verify(root)
        for b in bad:
            print(f"::error::{b}", file=sys.stderr)
        if bad:
            print(f"表与 qa.yml 不符 {len(bad)} 处 —— 不输出跳过计划,下游全量", file=sys.stderr)
            return 1
        print(f"verify ok: {len(SKIPPABLE_JOBS)} 个可跳 job、{len(MATRIX_JOBS)} 个矩阵 job",
              file=sys.stderr)
        if cmd == "plan":
            for k, v in plan(root).items():
                print(f"{k}={v}")
        return 0
    print(__doc__.split("用法:")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
