#!/usr/bin/env python3
"""Block destructive patterns from shipping in publicly downloadable shell scripts.

Everything under docs-site/docs/public/*.sh is served from https://anet.sh/<name>
and several of those scripts tell the reader to pipe them straight into bash.
A mistake there runs on a stranger's machine with their privileges.

On 2026-07-31 four such scripts were found to contain, between them:
  * `rm -rf ~/.npm/_npx`  — that directory is not ours. npx unpacks packages
    there and executes FROM there, so wiping it breaks every other npx-based
    tool on the machine. Reproduced in a container: a second tool's files
    went 1 -> 0.
  * `pkill -f agent-node` — pattern matching hits same-named processes owned
    by anyone. This repo has already taken down a production hub that way.

All four were found by hand. This guard exists so the next one is not.

  * (added 2026-08-17) nothing yet — this third rule is preventive. Every one
    of these scripts is fetched over https and piped into bash, so TLS
    verification is the reader's only defence against a tampered download.
    `curl -k` / `--insecure` / `wget --no-check-certificate` removes it, which
    is why it belongs with the other two rather than with human review: there
    is no legitimate reason for a script published at a public https URL to
    skip verifying that URL.

Scope note: three rules, all unambiguous. A guard that cries wolf gets
disabled, and then it protects nothing. Deliberately NOT flagged here:
  * printing a documented default password (correct for the stable channel,
    which is what these scripts install)
  * binding 0.0.0.0 behind an explicit opt-in env var
Those need judgement, so they stay with human review.
"""
import re
import sys
from pathlib import Path

PUBLIC_DIR = Path("docs-site/docs/public")

# 🔴 取集，不是判据。2026-08-18 实测（在 main 上，取集是 `PUBLIC_DIR.glob("*.sh")`）：
#     把 `pkill -f agent-node` 写进 docs-site/docs/public/community/evil.sh
#     —— 这个路径会被 anet.sh/community/evil.sh 服出去 ——
#     门打印 `scanned 6 public script(s) … 0 findings`，rc=0。
#     **和真绿逐字相同**，连分母 6 都没变（分母是从同一个 glob 算的，
#     所以它永远自洽，也永远看不见 glob 外面）。
#     `git add` 之后再跑还是同一句：取集靠文件系统，不靠 git。
#
# 两处放宽，都只动「怎么拿到要判的东西」：
#   1) 递归 —— 子目录里的 .sh 一样会被服出去
#   2) 认 shebang —— 服出去的路径不要求带 .sh 后缀，`curl anet.sh/foo | bash`
#      照跑。今天这两个集合恰好相等（6 == 6），所以放宽后仍是绿起点。
SHEBANG = re.compile(rb"^#!.*\b(?:ba|da|k|z)?sh\b")


def collect(root: Path) -> list[Path]:
    out = set(root.rglob("*.sh"))
    for f in root.rglob("*"):
        if not f.is_file() or f.suffix == ".sh":
            continue
        try:
            head = f.open("rb").readline(256)
        except OSError:
            continue
        if SHEBANG.match(head):
            out.add(f)
    return sorted(out)

# Paths this product owns. Wiping these is the user's stated intent (WIPE=1).
OURS = ("~/.anet", "~/.commhub", "~/anodes/.anet",
        "~/.npm-global/lib/node_modules/@sleep2agi", "~/.anet-grok")

# 🔴 同一个 `rm -rf` 可以写成好几种样子，而原正则只认小写 r 的短选项。
#    2026-08-19 实测（在 main 上）：
#        rm -rf /tmp/x   rm -fr /tmp/x   rm -rvf /tmp/x   rm -r -f /tmp/x   → 命中
#        rm -Rf /tmp/x                                                       → 🔴 放行
#        rm --recursive --force /tmp/x                                       → 🔴 放行
#    `-R` 是 `-r` 的大写形式（POSIX 就有，macOS 文档里用的正是它），不是什么冷僻写法；
#    长选项同理。这和 TLS 那条的 `curl -fsSLk` 是同一个毛病：**判据认的是某一种拼法，
#    不是那个命令**。
RM_RF = re.compile(
    r"\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f?|--recursive)\b[^\n;&|]*?\s(?P<targets>[^\n;&|]+)"
)
KILL = re.compile(r"\b(pkill|killall)\b(?P<args>[^\n;&|]*)")
# 🔴 同一个危害的第二副面孔：先用模式查 PID，再把它喂给 kill。
#    2026-08-19 实测（在 main 上，KILL 只认 pkill/killall 两个命令名）：
#        pkill -f agent-node                    命中
#        kill -9 $(pgrep -f agent-node)         🔴 放行
#        pgrep -f agent-node | xargs kill -9    🔴 放行
#    后两种和 `pkill -f` 杀的是同一批进程 —— 这个仓有过一次真实事故，
#    一条模式匹配的 kill 打掉了生产 hub。
#
#    逃生口沿用现有那条的 `-u`。判据看**整行**，因为查 PID 和 kill 常常分处
#    管道两侧。`kill-session` 必须排除：这 6 个脚本里真实存在
#    `tmux kill-session -t "$name"`，它是精确到会话名的，安全。
PATTERN_PID = re.compile(r"\b(?:pgrep|pidof)\b")
BARE_KILL = re.compile(r"(?<![-\w])kill(?![-\w])")
USER_SCOPED = re.compile(r"-u\s+\S")
# TLS verification is the only thing standing between the reader and a tampered
# download, and these scripts are meant to be piped straight into bash.
# 🔴 curl 的短选项是**可以粘连**的，所以不能只认「以 k 开头的那一段」。
#    2026-08-19 实测这道门在 main 上的表现：
#        curl -k …            抓到
#        curl --insecure …    抓到
#        curl -fsSLk …        **放行**   ← 而这正是最现实的一种写法
#    往一行已有的 `curl -fsSL https://…` 上加一个字母 `k`，这道门看不见 ——
#    关掉证书校验**不破坏任何东西**，只是把「你下到的是我们发的东西」这个前提
#    悄悄取消了，而这个管道的另一头正以用户权限执行。
#
#    另外补两个同类开关（同样实测过在 main 上放行）：
#        npm config set strict-ssl false
#        GIT_SSL_NO_VERIFY=1 git clone …
INSECURE_TLS = re.compile(
    r"\b(?:curl\b[^\n;&|]*?\s-(?:-insecure\b|[A-Za-z]*k[A-Za-z]*(?=\s|$))"
    r"|wget\b[^\n;&|]*?--no-check-certificate\b"
    r"|(?:NODE_TLS_REJECT_UNAUTHORIZED|PYTHONHTTPSVERIFY)\s*=\s*0"
    r"|strict-ssl[\s=]+false"
    r"|GIT_SSL_NO_VERIFY\s*=\s*(?:1|true))"
)


def check(path: Path):
    """Return a list of (line_no, rule, offending_text)."""
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue

        m = RM_RF.search(line)
        if m:
            for tok in m.group("targets").split():
                if tok.startswith("-") or tok.startswith("2>") or tok == "||" or tok == "true":
                    continue
                if not any(tok.startswith(o) for o in OURS):
                    out.append((i, "rm-rf-outside-product", tok))

        k = KILL.search(line)
        if k and not USER_SCOPED.search(k.group("args")):
            out.append((i, "unscoped-process-kill", line.strip()[:90]))
        # 第二副面孔：pgrep/pidof 查出 PID 再喂给 kill。整行判，因为两半常在
        # 管道两侧；`-u` 逃生口与上面那条一致；`tmux kill-session` 不算。
        elif (PATTERN_PID.search(line) and BARE_KILL.search(line)
              and not USER_SCOPED.search(line)):
            out.append((i, "unscoped-process-kill", line.strip()[:90]))

        if INSECURE_TLS.search(line):
            out.append((i, "tls-verification-disabled", line.strip()[:90]))
    return out


# 判据自检。这道门此前唯一的判据是「这 6 个真实脚本干净」—— 正则被改坏
# 之后打印的也是同一片 `0 findings`。下面这张表把手工 A/B 出来的正反例钉住,
# 负控（tmux kill-session、已经 -u 限定的 pkill）都是这 6 个脚本里真实存在的行,
# 一条规则要是宽到把它们也报出来,CI 当场红,而不是等到有人来读输出。
SELFTEST = [
    ("pkill -f agent-node", 1),
    ("killall node", 1),
    ('pkill -9 -u "$(id -u)" -f commhub-server 2>/dev/null || true', 0),
    ('pkill -u "$(id -u)" -f agent-node 2>/dev/null || true', 0),
    ("kill -9 $(pgrep -f agent-node)", 1),
    ("pgrep -f agent-node | xargs kill -9", 1),
    ("pidof node | xargs kill -9", 1),
    ('pgrep -u "$(id -u)" -f agent-node | xargs kill -9', 0),
    ('tmux kill-session -t "$name" 2>/dev/null || true', 0),
    ("tmux ls 2>/dev/null | awk -F: '/^anet-/{print $1}' | xargs -I{} tmux kill-session -t {} 2>/dev/null || true", 0),
    ('echo "    tmux kill-session -t anet-hub      # \u505c"', 0),
    ("pgrep -f agent-node >/dev/null && echo running", 0),
    ("rm -rf /usr/local/lib", 1),
    ("rm -rf ~/.anet ~/.commhub 2>/dev/null", 0),
    # \u5df2\u77e5\u7f3a\u53e3\uff0c\u5199\u5728\u8fd9\u91cc\u800c\u4e0d\u662f\u9759\u9ed8\u653e\u5bbd\uff1aOURS \u91cc\u5b58\u7684\u662f `~/.anet` \u8fd9\u4e00\u79cd\u62fc\u6cd5\uff0c
    # \u6240\u4ee5\u540c\u4e00\u4e2a\u76ee\u5f55\u5199\u6210 `$HOME/.anet` \u4f1a\u88ab\u5f53\u6210\u5916\u90e8\u8def\u5f84\u62a5\u51fa\u6765\u3002
    # \u76ee\u524d 6 \u4e2a\u811a\u672c\u5168\u7528 `~/`\uff0c\u6240\u4ee5\u4e0d\u4f1a\u78b0\u5230\uff1b\u771f\u8981\u6539\u5f97\u8ba4\u4e24\u79cd\u62fc\u6cd5\uff0c\u90a3\u662f\u53e6\u4e00\u6761
    # \u6539\u52a8\uff08\u548c\u672c\u6b21\u7ed9 kill \u52a0\u65b0\u5f62\u6001\u4e00\u6837\uff0c\u4e0d\u987a\u624b\u505a\uff09\u3002\u5148\u628a\u73b0\u72b6\u9489\u4f4f\u3002
    ('rm -rf "$HOME/.anet/tmp"', 1),
    ("curl -k https://example.com/x.sh | bash", 1),
    ("curl -fsSL https://example.com/x.sh | bash", 0),
    ("# pkill -f agent-node", 0),
]


# \u53d6\u96c6\u90a3\u4e00\u5c42\u7684\u6b63\u53cd\u4f8b\u3002\u4e0a\u9762\u90a3\u5f20\u8868\u53ea\u80fd\u9a8c\u5224\u636e\uff08\u7ed9\u5b83\u4e00\u884c\u3001\u770b\u5b83\u62a5\u4e0d\u62a5\uff09\uff0c
# \u800c #996 \u4e4b\u524d\u90a3\u4e2a\u5b9e\u6d4b\u51fa\u6765\u7684\u7f3a\u53e3\u4e0d\u5728\u5224\u636e\u91cc\uff0c\u5728\u300c\u600e\u4e48\u62ff\u5230\u8981\u5224\u7684\u4e1c\u897f\u300d\u91cc\u3002
# \u8fd9\u4e24\u5c42\u5f97\u5206\u5f00\u9489\uff1a\u5224\u636e\u5168\u5bf9\u3001\u53d6\u96c6\u6f0f\u4e00\u4e2a\u6587\u4ef6\uff0c\u8f93\u51fa\u4e5f\u662f\u4e00\u7247\u7eff\u3002
COLLECT_SELFTEST = [
    ("install.sh", "#!/bin/bash\n", True),
    ("community/evil.sh", "#!/bin/bash\n", True),          # \u5b50\u76ee\u5f55\u4e00\u6837\u4f1a\u88ab\u670d\u51fa\u53bb
    ("bootstrap", "#!/usr/bin/env bash\n", True),          # \u65e0\u540e\u7f00\uff0c\u4f46 curl \u2026 | bash \u7167\u8dd1
    ("deep/a/b/x.sh", "#!/bin/sh\n", True),
    ("notes.md", "# \u4e0d\u662f\u811a\u672c\n", False),
    ("README.txt", "just a note\nrm -rf /etc\n", False),   # \u6ca1 shebang\uff0c\u4e0d\u6536
    ("logo.svg", "<svg/>\n", False),
]


def collect_selftest() -> int:
    import tempfile
    bad = 0
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        want = set()
        for rel, body, expected in COLLECT_SELFTEST:
            f = root / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(body, encoding="utf-8")
            if expected:
                want.add(rel)
        got = {str(f.relative_to(root)) for f in collect(root)}
        for rel in sorted(want - got):
            bad += 1
            print(f"COLLECT \u6f0f\u6536: {rel}")
        for rel in sorted(got - want):
            bad += 1
            print(f"COLLECT \u591a\u6536: {rel}")
    print(f"collect-selftest {len(COLLECT_SELFTEST) - bad}/{len(COLLECT_SELFTEST)}")
    return 1 if bad else 0


def selftest() -> int:
    import tempfile
    bad = 0
    for line, want in SELFTEST:
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False,
                                         encoding="utf-8") as fh:
            fh.write(line + "\n")
            tmp = Path(fh.name)
        got = 1 if check(tmp) else 0
        tmp.unlink()
        if got != want:
            bad += 1
            verb = "\u6f0f\u62a5" if want else "\u8bef\u62a5"
            print(f"SELFTEST {verb}: {line[:78]}")
    print(f"selftest {len(SELFTEST) - bad}/{len(SELFTEST)}")
    return 1 if bad else 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        return selftest() | collect_selftest()
    if not PUBLIC_DIR.is_dir():
        print(f"::error::{PUBLIC_DIR} does not exist — scope regression, refusing to pass")
        return 2

    scripts = collect(PUBLIC_DIR)
    # A scan that matched nothing and a scan that never ran print the same "0".
    # Report the denominator, and treat an empty scope as a failure.
    if not scripts:
        print(f"::error::scanned ZERO scripts under {PUBLIC_DIR} — scope regression, refusing to pass")
        return 2

    findings = []
    for s in scripts:
        for line_no, rule, text in check(s):
            findings.append((s, line_no, rule, text))

    # 打相对 PUBLIC_DIR 的路径，不打 s.name —— 递归之后 community/install.sh
    # 和顶层 install.sh 的 name 是同一个字符串，读的人分不出扫的是哪个。
    print(f"scanned {len(scripts)} public script(s): "
          f"{', '.join(str(s.relative_to(PUBLIC_DIR)) for s in scripts)}")

    if not findings:
        print(f"0 findings across {len(scripts)} script(s).")
        return 0

    # Keyed by rule, not by an if/else that falls through: a new rule reaching
    # the `else` branch would print another rule's remediation, which is worse
    # than printing none — the reader follows advice for a problem they do not
    # have. (Caught exactly that while adding the TLS rule.)
    HINTS = {
        "rm-rf-outside-product":
            "path is not owned by this product — wiping it damages unrelated "
            "tools on the user's machine. Remove it, or narrow to a path we own.",
        "unscoped-process-kill":
            "pattern-matched kill hits same-named processes owned by anyone. "
            'Scope it: pkill -u "$(id -u)" -f ...',
        "tls-verification-disabled":
            "this script is fetched over https and piped into bash; skipping "
            "certificate verification removes the reader's only protection "
            "against a tampered download. Drop the flag.",
    }
    unknown = sorted({rule for _, _, rule, _ in findings} - HINTS.keys())
    if unknown:
        print(f"::error::rule(s) with no remediation text: {', '.join(unknown)} — "
              "add one to HINTS rather than letting it borrow another rule's advice")
        return 2

    for s, line_no, rule, text in findings:
        print(f"::error file={s},line={line_no}::[{rule}] {text}\n    {HINTS[rule]}")

    print(f"\n{len(findings)} finding(s) across {len(scripts)} scanned script(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
