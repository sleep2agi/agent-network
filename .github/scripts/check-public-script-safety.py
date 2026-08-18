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
        return selftest()
    if not PUBLIC_DIR.is_dir():
        print(f"::error::{PUBLIC_DIR} does not exist — scope regression, refusing to pass")
        return 2

    scripts = sorted(PUBLIC_DIR.glob("*.sh"))
    # A scan that matched nothing and a scan that never ran print the same "0".
    # Report the denominator, and treat an empty scope as a failure.
    if not scripts:
        print(f"::error::scanned ZERO scripts under {PUBLIC_DIR} — scope regression, refusing to pass")
        return 2

    findings = []
    for s in scripts:
        for line_no, rule, text in check(s):
            findings.append((s, line_no, rule, text))

    print(f"scanned {len(scripts)} public script(s): {', '.join(s.name for s in scripts)}")

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
