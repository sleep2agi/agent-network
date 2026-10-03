#!/usr/bin/env python3
"""Mutation anchors under tests/ must still hit the source they mutate.

Usage:
  python3 scripts/check-mutation-pins.py                 # scan this checkout
  python3 scripts/check-mutation-pins.py --selftest      # judge + collection self-tests
  python3 scripts/check-mutation-pins.py --root DIR      # scan another tree (e.g. an old commit)
  python3 scripts/check-mutation-pins.py --list          # also print every anchor + every unchecked one
  python3 scripts/check-mutation-pins.py --write-baseline   # rewrite the unchecked ratchet baseline

Exit codes:
  0  green: every checked anchor still hits its target the expected number of times,
     and the unchecked count is within the committed baseline
  1  red: at least one anchor no longer applies (the harness would report
     MUTATION_NOOP / "anchor count=0" / "expected exactly one ..." in Docker CI)
  2  ratchet: more anchors are *unchecked* (dynamic / unresolvable) than the committed
     baseline `scripts/mutation-pins-baseline.json` allows -- a new harness
     opted out of this gate. Also used for usage errors.

Why (2026-08-31 first incident, 2026-10-03/04 again twice):
  test649's L5 mutation pinned `(t.created_at || "?").padEnd(24)`; that line was refactored,
  the sed matched nothing and the suite went red for a reason that looked like a product
  regression. On 10-03/04 the same thing happened through two forms this gate did not read:
  test697's `run_mutation NAME LAYER FILE FROM TO PROBE` helper (PR #2320) and
  test-status-read-cache's `bun mutate.ts FILE BEFORE AFTER` (PR #2325). Both were found
  only by the Docker L2 suites, late. This is a pure text check that runs in seconds.

Forms understood (a "use" is one (target file, before-string) pair):
  sed       `sed -i[SUF] [-E] [-e] 's/PAT/REPL/' FILE` and `/RE/d` style addresses (BRE/ERE)
  perl      `perl -0pi -e 's/PAT/REPL/flags' FILE` (Perl regex, translated to Python re)
  grep-count  `N=$(grep -Fc 'LIT' FILE)` followed by `[[ "$N" == "3" ]]` -> exactly 3
  js / ts / python mutators, inline (`bun -e`, `node -e`, `python3 - <<EOF`, `python3 -c`)
            or as script files (`bun mutate.ts FILE BEFORE AFTER`, `node mutate.mjs MODE PATH`,
            `bun /harness/mutate.ts MODE`), found by data flow: a variable read from a file
            (`readFileSync` / `read_text()`), then `.split/.replace/.indexOf/.includes/.count(X)`
            on it. X / the file may be literals, consts, argv, env vars, wrapper-function
            params (`replaceExact(path, before, after)`) or a `{mode: [before, after]}` table.
  shell helpers: any shell function / script whose body routes its positional params into
            one of the above (`run_mutation`, `run_mutation_pair`, tests/lib/mutation-guard.sh
            `mutate NAME FILE cmd...`, `run-mutation.sh MODE`) is followed to its call sites.
  Shell variables, `$'...'`, `$(cat <<'EOF' ... EOF)` heredoc literals, `cd`, and Dockerfile
  WORKDIR / COPY mappings are resolved so container paths map back to repo files.

Judgement: literal anchors must occur exactly N times when the harness enforces N
(`!== 1`, `count != 1`, `[[ $C == 3 ]]`, first/second indexOf check), else >= 1.
Regex anchors (sed/perl) must match at least once.

Anything that cannot be resolved statically is listed as "unchecked (reason)" -- never
silently dropped -- and the count is ratcheted against the baseline file.
"""
import json
import os
import re
import sys
import warnings

warnings.simplefilter("ignore", FutureWarning)     # "possible nested set" from translated brackets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE_DEFAULT = os.path.join(ROOT, "scripts", "mutation-pins-baseline.json")
PKG_ROOTS = ("agent-node", "agent-network", "server", "dashboard", "prototype/anet-client-app")

MARKER_RE = re.compile(r"mutat|MUTATION|NOOP|witnessed.red|WITNESSED", re.I)
WRITE_RE = re.compile(r"\bsed\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*i|\bperl\s+-\S*i|writeFileSync|\bwrite_text\(|Bun\.write\(")


# ─────────────────────────────── values ─────────────────────────────────────
# A Value is a tuple of segments:
#   ("L", text)   literal                 ("P", n)  positional arg n (1-based; shell $n, script argv)
#   ("E", name)   env / shell variable    ("F", i)  param i of a JS/Python wrapper function (0-based)
#   ("D", why)    dynamic, not resolvable
def VL(s):
    return (("L", s),)


def VD(why):
    return (("D", why),)


def vnorm(segs):
    out = []
    for s in segs:
        if s[0] == "L":
            if s[1] == "":
                continue
            if out and out[-1][0] == "L":
                out[-1] = ("L", out[-1][1] + s[1])
                continue
        out.append(s)
    return tuple(out) if out else (("L", ""),)


def vlit(v):
    """The literal text of a fully-literal Value, else None."""
    if v is None:
        return None
    if all(s[0] == "L" for s in v):
        return "".join(s[1] for s in v)
    return None


def vdesc(v):
    parts = []
    for s in v or ():
        if s[0] == "L":
            parts.append(s[1])
        elif s[0] == "P":
            parts.append("$%d" % s[1])
        elif s[0] == "E":
            parts.append("$" + s[1])
        elif s[0] == "F":
            parts.append("<param %d>" % s[1])
        elif s[0] in ("T", "K"):
            parts.append("<table>")
        else:
            parts.append("<%s>" % s[1])
    return "".join(parts)


def vwhy(v):
    """Why a Value is not literal (first non-literal segment)."""
    for s in v or ():
        if s[0] == "P":
            return "positional $%d never bound to a literal" % s[1]
        if s[0] == "E":
            return "variable $%s not resolvable statically" % s[1]
        if s[0] == "F":
            return "wrapper param %d not bound" % s[1]
        if s[0] == "D":
            return s[1]
        if s[0] in ("T", "K"):
            return "table lookup"
    return "?"


def vsubst(v, args=None, env=None, fargs=None):
    if v is None:
        return None
    out = []
    for s in v:
        if s[0] == "P" and args is not None:
            out.extend(args[s[1] - 1] if 0 < s[1] <= len(args) else VD("positional $%d not passed" % s[1]))
        elif s[0] == "E" and env is not None and s[1] in env:
            out.extend(env[s[1]])
        elif s[0] == "F" and fargs is not None:
            out.extend(fargs[s[1]] if s[1] < len(fargs) else VD("wrapper param %d not passed" % s[1]))
        elif s[0] == "T":
            out.append(("T", s[1], vsubst(s[2], args, env, fargs)) + tuple(s[3:]))
        elif s[0] == "K":
            out.append(("K", vsubst(s[1], args, env, fargs)))
        else:
            out.append(s)
    return vnorm(out)


class Use:
    """One mutation anchor: `needle` must hit `target`."""
    __slots__ = ("form", "kind", "needle", "target", "expect", "cwd", "origin", "via", "flags", "ctx", "rootfile", "soft")

    def __init__(self, form, kind, needle, target, expect, origin, cwd=None, flags="", ctx=None):
        self.form, self.kind, self.needle, self.target = form, kind, needle, target
        self.expect = expect          # ("exact", n) | ("min", 1)
        self.origin = origin          # (relpath, line)
        self.cwd = cwd                # Value or None
        self.via = ()                 # call sites (relpath, line), innermost first
        self.flags = flags
        self.ctx = ctx                # suite dir (abs) used for Dockerfile mapping
        self.rootfile = None
        self.soft = False             # weak evidence it is a mutation: drop (not "unchecked") if the target is not a repo file

    def inst(self, args=None, env=None, fargs=None, cwd=None, via=None, ctx=None):
        u = Use(self.form, self.kind, vsubst(self.needle, args, env, fargs),
                vsubst(self.target, args, env, fargs), self.expect, self.origin,
                vsubst(self.cwd, args, env, fargs) if self.cwd is not None else cwd,
                self.flags, ctx or self.ctx)
        u.via = self.via + ((via,) if via else ())
        u.soft = self.soft
        return u


# ───────────────────────── regex translation (kept) ──────────────────────────
def unescape(pattern: str) -> str:
    """sed backslash escapes back to literal text (\\. -> . / \\[ -> [ ...)."""
    return re.sub(r"\\(.)", r"\1", pattern)


# sed uses **BRE**: only . * [ ] ^ $ and \( \) \{ \} are meta; ? + | ( ) { } are literal.
_POSIX_CLASSES = {"space": r"\s", "digit": "0-9", "alnum": "A-Za-z0-9", "alpha": "A-Za-z", "upper": "A-Z",
                  "lower": "a-z", "blank": r" \t", "xdigit": "0-9A-Fa-f", "punct": r"!-/:-@\[-`{-~", "word": r"\w"}


def _posix(p):
    return re.sub(r"\[:(\w+):\]", lambda m: _POSIX_CLASSES.get(m.group(1), m.group(0)), p)


def _bracket(pattern, i):
    """POSIX bracket expression at pattern[i] == "[" -> (python class, next index) or (None, i)."""
    j = i + 1
    if j < len(pattern) and pattern[j] == "^":
        j += 1
    if j < len(pattern) and pattern[j] == "]":
        j += 1
    while j < len(pattern) and pattern[j] != "]":
        if pattern.startswith("[:", j):
            k = pattern.find(":]", j + 2)
            j = k + 2 if k >= 0 else j + 1
            continue
        j += 1
    if j >= len(pattern):
        return None, i
    body = pattern[i + 1:j]
    neg = body.startswith("^")
    if neg:
        body = body[1:]
    out = []
    k = 0
    while k < len(body):
        m = re.match(r"\[:(\w+):\]", body[k:])
        if m:
            out.append(_POSIX_CLASSES.get(m.group(1), ""))
            k += m.end()
            continue
        ch = body[k]
        out.append("\\" + ch if ch in "\\[]^" else ch)    # backslash is literal inside POSIX brackets
        k += 1
    return "[" + ("^" if neg else "") + "".join(out) + "]", j + 1


def bre_to_regex(pattern: str):
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "[":
            cls, nxt = _bracket(pattern, i)
            if cls is not None:
                out.append(cls)
                i = nxt
                continue
        if c == "\\" and i + 1 < len(pattern):
            nxt = pattern[i + 1]
            if nxt in "(){}":
                out.append(nxt)
            elif nxt == "n":
                out.append("\n")
            elif nxt == "t":
                out.append("\t")
            elif nxt in "+?|":
                out.append(nxt)          # GNU BRE extensions \+ \? \|
            else:
                out.append(re.escape(nxt))
            i += 2
            continue
        if c == "^":
            out.append("^" if i == 0 else re.escape("^"))
        elif c == "$":
            out.append("$" if i == len(pattern) - 1 else re.escape("$"))
        elif c in ".*[]":
            out.append(c)
        else:
            out.append(re.escape(c))
        i += 1
    try:
        return re.compile("".join(out), re.M)
    except re.error:
        return None


def ere_to_regex(pattern: str):
    pattern = _posix(pattern)
    try:
        return re.compile(pattern.replace(r"\<", r"\b").replace(r"\>", r"\b"), re.M)
    except re.error:
        return None


def perl_to_regex(pattern: str, flags: str, slurp: bool):
    if re.search(r"\\[QEGKzZ]|\(\?<[=!]?\w*>|\(\?\{|\\p\{", pattern):
        return None
    f = 0
    if "i" in flags:
        f |= re.I
    if "s" in flags:
        f |= re.S
    if "x" in flags:
        f |= re.X
    if "m" in flags or not slurp:
        f |= re.M
    try:
        return re.compile(pattern, f)
    except re.error:
        return None


def ansi_c_unescape(s: str) -> str:
    table = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"', "a": "\a",
             "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "v": "\v", "?": "?"}
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            if n in table:
                out.append(table[n]); i += 2; continue
            m = re.match(r"x([0-9A-Fa-f]{1,2})", s[i + 1:])
            if m:
                out.append(chr(int(m.group(1), 16))); i += 1 + len(m.group(0)); continue
            m = re.match(r"([0-7]{1,3})", s[i + 1:])
            if m:
                out.append(chr(int(m.group(1), 8))); i += 1 + len(m.group(0)); continue
            out.append(c + n); i += 2; continue
        out.append(c); i += 1
    return "".join(out)


# ─────────────────────────── path resolution ─────────────────────────────────
class Resolver:
    """Map a target path as written in a harness (container path, relative path, $ROOT/...)
    to exactly one file in the scanned tree. **Never guesses**: ambiguous -> None."""

    def __init__(self, root):
        self.root = root
        self._docker = {}
        self._isfile = {}

    def isfile(self, rel):
        r = self._isfile.get(rel)
        if r is None:
            r = self._isfile[rel] = os.path.isfile(os.path.join(self.root, rel))
        return r

    def docker(self, ctx):
        """[(container_dest_abs, repo_src_rel, is_dir_hint)], [workdirs] for a suite dir."""
        if ctx in self._docker:
            return self._docker[ctx]
        maps, workdirs = [], []
        try:
            names = [n for n in os.listdir(ctx) if n.startswith("Dockerfile")]
        except OSError:
            names = []
        for name in names:
            wd = "/"
            try:
                text = open(os.path.join(ctx, name), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            text = re.sub(r"\\\n", " ", text)
            for line in text.splitlines():
                m = re.match(r"\s*WORKDIR\s+(\S+)", line, re.I)
                if m:
                    wd = os.path.normpath(os.path.join(wd, m.group(1)))
                    workdirs.append(wd)
                    continue
                m = re.match(r"\s*(?:COPY|ADD)\s+(.*)$", line, re.I)
                if not m or "--from" in m.group(1):
                    continue
                parts = [p for p in m.group(1).split() if not p.startswith("--")]
                if parts and parts[0].startswith("["):
                    try:
                        parts = json.loads(m.group(1)[m.group(1).index("["):])
                    except ValueError:
                        continue
                if len(parts) < 2:
                    continue
                dest = parts[-1]
                dest_abs = os.path.normpath(os.path.join(wd, dest))
                for src in parts[:-1]:
                    src = src.rstrip("/").lstrip("./") if src not in (".", "./") else ""
                    if len(parts) > 2 or dest.endswith("/"):
                        tgt = os.path.normpath(os.path.join(dest_abs, os.path.basename(src))) if src and not os.path.isdir(os.path.join(self.root, src)) else dest_abs
                    else:
                        tgt = dest_abs
                    maps.append((tgt, src))
        res = (maps, workdirs)
        self._docker[ctx] = res
        return res

    def _via_docker(self, abspath, ctx):
        if not ctx:
            return set()
        maps, _ = self.docker(ctx)
        hits = set()
        for dest, src in maps:
            if abspath == dest:
                cand = src
            elif abspath.startswith(dest.rstrip("/") + "/"):
                cand = os.path.join(src, abspath[len(dest.rstrip("/")) + 1:]) if src else abspath[len(dest.rstrip("/")) + 1:]
            else:
                continue
            cand = os.path.normpath(cand)
            if self.isfile(cand):
                hits.add(cand)
        return hits

    def _suffix(self, comps):
        """Longest suffix of path components that names a repo file; then unique package root."""
        for k in range(len(comps)):
            c = "/".join(comps[k:])
            if c and self.isfile(c):
                return c
        for k in range(len(comps)):
            c = "/".join(comps[k:])
            if not c:
                continue
            hits = [os.path.join(p, c) for p in PKG_ROOTS if self.isfile(os.path.join(p, c))]
            if len(hits) == 1:
                return hits[0]
            if len(hits) > 1:
                return None          # ambiguous: do not guess
        return None

    def resolve_dir(self, v, cwd=None):
        """Value naming a repo directory (agent-node, /workspace/agent-node, $ROOT/server) -> rel or None"""
        tail = v[-1][1] if v and v[-1][0] == "L" else ""
        if len(v) > 1 and not tail.startswith("/"):
            return None
        comps = [c for c in os.path.normpath(tail or "/").split("/") if c not in ("", ".")]
        if not comps and cwd is None:
            return None
        for k in range(len(comps)):
            c = "/".join(comps[k:])
            if os.path.isdir(os.path.join(self.root, c)) and c != "tests":
                return c
        return None

    def resolve(self, v, cwd=None, ctx=None):
        """Value -> repo-relative path or None."""
        if v is None:
            return None
        # drop everything up to the last non-literal segment that is followed by "/..."
        segs = list(v)
        last_dyn = max([i for i, s in enumerate(segs) if s[0] != "L"], default=-1)
        tail = "".join(s[1] for s in segs[last_dyn + 1:])
        if last_dyn >= 0:
            if not tail.startswith("/"):
                return None
            rel_unknown = tail.lstrip("/")
            comps = [c for c in os.path.normpath(rel_unknown).split("/") if c not in ("", ".")]
            return self._suffix(comps) if comps else None
        path = tail
        if not path:
            return None
        if path.startswith("~"):
            return None
        if not path.startswith("/"):
            rel = os.path.normpath(path)
            if rel.startswith(".."):
                rel = rel.lstrip("./")
            # 1) relative to a known cwd
            if cwd is not None:
                cw = vlit(cwd)
                if cw is not None:
                    if cw.startswith("/"):
                        hits = self._via_docker(os.path.normpath(os.path.join(cw, rel)), ctx)
                        if len(hits) == 1:
                            return hits.pop()
                        comps = [c for c in os.path.normpath(os.path.join(cw, rel)).split("/") if c]
                        hit = self._suffix(comps)
                        if hit:
                            return hit
                    else:
                        c = os.path.normpath(os.path.join(cw, rel))
                        if self.isfile(c):
                            return c
                else:
                    r = self.resolve(vnorm(tuple(cwd) + VL("/" + rel)), None, ctx)
                    if r:
                        return r
            # 2) relative to a Dockerfile WORKDIR
            if ctx:
                hits = set()
                for wd in self.docker(ctx)[1]:
                    hits |= self._via_docker(os.path.normpath(os.path.join(wd, rel)), ctx)
                if len(hits) == 1:
                    return hits.pop()
            # 3) repo-relative, 4) unique package root
            if self.isfile(rel):
                return rel
            comps = [c for c in rel.split("/") if c not in ("", ".")]
            hits = [os.path.join(p, rel) for p in PKG_ROOTS if self.isfile(os.path.join(p, rel))]
            if len(hits) == 1:
                return hits[0]
            return None
        hits = self._via_docker(os.path.normpath(path), ctx)
        if len(hits) == 1:
            return hits.pop()
        comps = [c for c in os.path.normpath(path).split("/") if c]
        return self._suffix(comps)


# kept for the original selftest: plain-string resolution against this checkout
def resolve_target(target: str):
    return Resolver(ROOT).resolve(VL(target))


# ───────────────────────────── shell parsing ─────────────────────────────────
class Cmd:
    __slots__ = ("line", "words", "heredocs", "redirs")

    def __init__(self, line):
        self.line, self.words, self.heredocs, self.redirs = line, [], [], []


_SH_PLAIN = re.compile(r"[^\s'\"\\$`;&|()<>]+")
_HEREDOC_OP = re.compile(r"<<(-?)\s*(?:'([^']*)'|\"([^\"]*)\"|\\?([A-Za-z0-9_.-]+))")


def _match_close(text, i, open_ch, close_ch):
    """i points just after the opening char; return index of the matching close char."""
    depth, n = 1, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2; continue
        if c == "'" and open_ch == "(":
            j = text.find("'", i + 1)
            i = (j + 1) if j >= 0 else n; continue
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            i = j + 1; continue
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return n


def sh_parse(text, line0=1):
    """Tokenise shell text into simple commands. Words are lists of parts:
    ("L", s) literal, ("V", name, rest) parameter, ("C", text, line) command substitution."""
    cmds, n, i, line = [], len(text), 0, line0
    cur = Cmd(line)
    word = None
    redir_next = False
    pending = []          # heredocs waiting for the next newline

    def end_word():
        nonlocal word, redir_next
        if word is not None:
            (cur.redirs if redir_next else cur.words).append(word)
            redir_next = False
        word = None

    def end_cmd():
        nonlocal cur
        end_word()
        if cur.words or cur.heredocs:
            cmds.append(cur)
        cur = Cmd(line)

    def addp(p):
        nonlocal word
        if word is None:
            word = []
        word.append(p)

    while i < n:
        c = text[i]
        if c == "\n":
            end_word()
            heredoc_owner = cur
            end_cmd()
            i += 1; line += 1
            for strip, delim, owner in pending:
                body = []
                while i < n:
                    j = text.find("\n", i)
                    j = n if j < 0 else j
                    ln = text[i:j]
                    i = j + 1; line += 1
                    if (ln.lstrip("\t") if strip else ln) == delim:
                        break
                    body.append(ln)
                owner.heredocs.append((delim, "\n".join(body) + ("\n" if body else "")))
            pending = []
            cur.line = line
            continue
        if c in " \t\r":
            end_word(); i += 1; continue
        if c == "\\":
            if i + 1 < n and text[i + 1] == "\n":
                i += 2; line += 1; continue
            if i + 1 < n:
                addp(("L", text[i + 1]))
            i += 2; continue
        if c == "#" and word is None:
            j = text.find("\n", i)
            i = n if j < 0 else j; continue
        if c == "'":
            j = text.find("'", i + 1)
            j = n if j < 0 else j
            seg = text[i + 1:j]
            addp(("L", seg)); line += seg.count("\n"); i = j + 1; continue
        if c == '"':
            if word is None:
                word = []
            j = i + 1
            buf = []
            while j < n and text[j] != '"':
                d = text[j]
                if d == "\\" and j + 1 < n:
                    nx = text[j + 1]
                    if nx in '$`"\\':
                        buf.append(nx); j += 2; continue
                    if nx == "\n":
                        j += 2; line += 1; continue
                    buf.append(d); j += 1; continue
                if d == "$" or d == "`":
                    if buf:
                        word.append(("L", "".join(buf))); buf = []
                    j, part = _sh_dollar(text, j, line)
                    word.append(part); continue
                if d == "\n":
                    line += 1
                buf.append(d); j += 1
            if buf:
                word.append(("L", "".join(buf)))
            if not word:
                word.append(("L", ""))
            i = j + 1; continue
        if c == "$" and i + 1 < n and text[i + 1] == "'":
            j = i + 2
            while j < n and text[j] != "'":
                j += 2 if text[j] == "\\" else 1
            seg = text[i + 2:j]
            addp(("L", ansi_c_unescape(seg))); line += seg.count("\n"); i = j + 1; continue
        if c == "$" or c == "`":
            i, part = _sh_dollar(text, i, line)
            if part[0] == "C":
                line += part[1].count("\n")
            addp(part); continue
        if c in ";&|":
            end_cmd()
            i += 2 if text[i:i + 2] in (";;", "&&", "||", "|&", "&>") and text[i:i + 2] != "&>" else 1
            if text[i - 1:i + 1] == "&>":
                pass
            continue
        if c == "(":
            if word is not None and text[i:i + 2] == "()":
                addp(("L", "()")); i += 2; continue
            if word is not None and word and word[-1][0] == "L" and word[-1][1].endswith("="):
                j = _match_close(text, i + 1, "(", ")")       # array assignment NAME=( … )
                addp(("L", text[i:j + 1])); line += text.count("\n", i, j); i = j + 1; continue
            end_cmd(); i += 1; continue
        if c == ")":
            end_cmd(); i += 1; continue
        if c in "<>":
            m = _HEREDOC_OP.match(text, i) if text.startswith("<<", i) and not text.startswith("<<<", i) else None
            if m:
                end_word()
                delim = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None else m.group(4))
                pending.append((bool(m.group(1)), delim, cur))
                i = m.end(); continue
            if word is not None and all(p[0] == "L" and p[1].isdigit() for p in word):
                word = None
            end_word()
            j = i
            while j < n and text[j] in "<>&|":
                j += 1
            i = j
            while i < n and text[i] in " \t":
                i += 1
            redir_next = True
            continue
        m = _SH_PLAIN.match(text, i)
        if m:
            addp(("L", m.group(0))); i = m.end(); continue
        addp(("L", c)); i += 1
    end_cmd()
    return cmds


def _sh_dollar(text, i, line):
    """Parse $..., ${...}, $(...), `...` at text[i]; return (next_index, part)."""
    n = len(text)
    if text[i] == "`":
        j = text.find("`", i + 1)
        j = n if j < 0 else j
        return j + 1, ("C", text[i + 1:j], line)
    if i + 1 >= n:
        return i + 1, ("L", "$")
    nx = text[i + 1]
    if nx == "(":
        if text.startswith("((", i + 1):
            j = _match_close(text, i + 3, "(", ")")
            return j + 2, ("V", "$((", "")
        j = _match_close(text, i + 2, "(", ")")
        return j + 1, ("C", text[i + 2:j], line)
    if nx == "{":
        j = _match_close(text, i + 2, "{", "}")
        inner = text[i + 2:j]
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(.*)$", inner, re.S)
        if inner.startswith("#") and len(inner) > 1:
            return j + 1, ("V", "#len", inner)
        if not m:
            return j + 1, ("V", "?", inner)
        return j + 1, ("V", m.group(1), m.group(2))
    m = re.match(r"[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-]", text[i + 1:])
    if m:
        return i + 1 + len(m.group(0)), ("V", m.group(0), "")
    return i + 1, ("L", "$")


# ───────────────────────── JS / Python token analysis ────────────────────────
_JS_TOK = re.compile(r"""
  (?P<ws>\s+)
 |(?P<lc>//[^\n]*)
 |(?P<bc>/\*.*?\*/)
 |(?P<s1>'(?:[^'\\\n]|\\.|\\\n)*')
 |(?P<s2>"(?:[^"\\\n]|\\.|\\\n)*")
 |(?P<tpl>`(?:[^`\\$]|\\.|\$(?!\{))*`)
 |(?P<tpld>`)
 |(?P<num>\d[\w.]*)
 |(?P<id>[A-Za-z_$][\w$]*)
 |(?P<p>===|!==|==|!=|=>|<=|>=|\.\.\.|\?\.|\?\?|&&|\|\||[-+*/%<>=!?:;,.(){}\[\]&|^~@#])
""", re.S | re.X)

_PY_TOK = re.compile(r"""
  (?P<ws>[ \t\f\r]+|\\\n)
 |(?P<nl>\n)
 |(?P<lc>\#[^\n]*)
 |(?P<str>(?P<pre>[rRbBuUfF]{0,2})(?P<q>'''|\"\"\"|'|")(?P<body>(?:\\.|(?!(?P=q))[^\\])*?)(?P=q))
 |(?P<num>\d[\w.]*)
 |(?P<id>[A-Za-z_][\w]*)
 |(?P<p>==|!=|<=|>=|->|\*\*|//|[-+*/%<>=!?:;,.(){}\[\]&|^~@])
""", re.S | re.X)

_JS_ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def js_unescape(s):
    def rep(m):
        e = m.group(1)
        if e[0] in _JS_ESC and (e[0] != "0" or len(e) == 1):
            return _JS_ESC[e[0]] + e[1:]
        if e[0] == "\n":
            return ""
        if e[0] == "x":
            return chr(int(e[1:3], 16))
        if e[0] == "u":
            h = e[2:-1] if e[1] == "{" else e[1:5]
            return chr(int(h, 16))
        return e
    return re.sub(r"\\(x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|[\s\S])", rep, s)


def py_unescape(s, raw):
    if raw:
        return s
    try:
        return s.encode("latin-1", "backslashreplace").decode("unicode_escape")
    except Exception:
        return js_unescape(s)


def js_tokens(text):
    toks, i, n = [], 0, len(text)
    line = 1
    while i < n:
        c = text[i]
        if c == "/" and text[i:i + 2] not in ("//", "/*"):
            prev = toks[-1] if toks else None
            if prev is None or (prev[0] == "p" and prev[1] not in (")", "]", "}")) or (prev[0] == "id" and prev[1] in ("return", "typeof", "case", "of", "in")):
                j, cls = i + 1, False
                while j < n and text[j] != "\n":
                    d = text[j]
                    if d == "\\":
                        j += 2; continue
                    if d == "[":
                        cls = True
                    elif d == "]":
                        cls = False
                    elif d == "/" and not cls:
                        break
                    j += 1
                m = re.match(r"[a-z]*", text[j + 1:])
                toks.append(("re", text[i + 1:j], line, m.group(0)))
                i = j + 1 + len(m.group(0)); continue
        m = _JS_TOK.match(text, i)
        if not m:
            i += 1; continue
        k = m.lastgroup
        v = m.group(0)
        if k in ("s1", "s2"):
            toks.append(("str", js_unescape(v[1:-1]), line))
        elif k == "tpl":
            toks.append(("str", js_unescape(v[1:-1]), line))
        elif k == "tpld":
            j = i + 1
            while j < n and text[j] != "`":
                if text[j] == "\\":
                    j += 1
                elif text.startswith("${", j):
                    j = _match_close(text, j + 2, "{", "}")
                j += 1
            toks.append(("str", None, line))
            line += text.count("\n", i, j)
            i = j + 1; continue
        elif k in ("id", "num", "p"):
            toks.append((k if k != "num" else "num", v, line))
        line += v.count("\n")
        i = m.end()
    return toks


def py_tokens(text):
    toks, i, n, line = [], 0, len(text), 1
    while i < n:
        m = _PY_TOK.match(text, i)
        if not m:
            i += 1; continue
        k = m.lastgroup if m.lastgroup not in ("pre", "q", "body") else "str"
        v = m.group(0)
        if m.group("str") is not None:
            pre = (m.group("pre") or "").lower()
            body = m.group("body")
            if "f" in pre and "{" in body:
                toks.append(("str", None, line))
            else:
                toks.append(("str", py_unescape(body, "r" in pre), line))
        elif m.group("nl") is not None:
            toks.append(("nl", "\n", line))
        elif m.group("id") is not None:
            toks.append(("id", v, line))
        elif m.group("num") is not None:
            toks.append(("num", v, line))
        elif m.group("p") is not None:
            toks.append(("p", v, line))
        line += v.count("\n")
        i = m.end()
    return toks


def _fold_strings(toks, py):
    """'a' + 'b' -> 'ab'; Python adjacent literals 'a' 'b' -> 'ab'."""
    out = []
    for t in toks:
        if t[0] == "str" and out:
            if py and out[-1][0] == "str":
                a = out.pop()
                out.append(("str", None if a[1] is None or t[1] is None else a[1] + t[1], a[2]))
                continue
            if len(out) >= 2 and out[-1] == ("p", "+", out[-1][2]) and out[-2][0] == "str":
                out.pop()
                a = out.pop()
                out.append(("str", None if a[1] is None or t[1] is None else a[1] + t[1], a[2]))
                continue
        out.append(t)
    return out


_READERS_JS = {"readFileSync", "readFile"}
TABLES = []       # mode tables of JS/Python mutators: [[(key, before, origin)], ...]
_NEEDLE_METHODS_JS = {"split", "replace", "replaceAll", "indexOf", "includes", "lastIndexOf"}
_NEEDLE_METHODS_PY = {"count", "replace", "find", "index", "rfind", "split", "rindex"}


class Script:
    """Data-flow analysis of one JS/TS or Python program text -> symbolic Uses."""

    def __init__(self, text, lang, origin_file, argv_offset, ctx):
        self.lang, self.file, self.ctx = lang, origin_file, ctx
        self.argv_offset = argv_offset   # P(n) = argv[n + offset]  (script file: offset 1; node -e: 0)
        self.py = lang == "py"
        toks = py_tokens(text) if self.py else js_tokens(text)
        self.toks = _fold_strings(toks, self.py)
        self.uses = []
        self.text = text
        self._analyse()

    # -- helpers ---------------------------------------------------------------
    def _match(self, i, open_ch, close_ch):
        depth = 0
        for j in range(i, len(self.toks)):
            t = self.toks[j]
            if t[0] == "p" and t[1] in "([{":
                depth += 1
            elif t[0] == "p" and t[1] in ")]}":
                depth -= 1
                if depth == 0:
                    return j
        return len(self.toks) - 1

    def _split_args(self, i, j):
        """tokens strictly between i and j, split on depth-0 commas"""
        args, cur, depth = [], [], 0
        for t in self.toks[i + 1:j]:
            if t[0] == "p" and t[1] in "([{":
                depth += 1
            elif t[0] == "p" and t[1] in ")]}":
                depth -= 1
            if depth == 0 and t[0] == "p" and t[1] == ",":
                args.append(cur); cur = []
                continue
            cur.append(t)
        if cur:
            args.append(cur)
        return args

    def _expr_end(self, i):
        """index one past the end of the expression starting at i"""
        depth, j, n = 0, i, len(self.toks)
        start_line = self.toks[i][2] if i < n else 0
        while j < n:
            t = self.toks[j]
            if t[0] == "p" and t[1] in "([{":
                depth += 1
            elif t[0] == "p" and t[1] in ")]}":
                if depth == 0:
                    return j
                depth -= 1
            elif depth == 0:
                if t[0] == "p" and t[1] in (";", ","):
                    return j
                if t[0] == "nl":
                    return j
                if not self.py and t[2] > start_line and j > i:
                    prev = self.toks[j - 1]
                    cont = prev[0] == "p" and prev[1] not in (")", "]", "}") or (t[0] == "p" and t[1] in (".", "?.", "+", "?", ":", "??", "||", "&&"))
                    if not cont:
                        return j
            j += 1
        return j

    def eval(self, toks, scope):
        """token slice -> Value"""
        toks = [t for t in toks if not (t[0] == "nl")]
        while toks and toks[-1][0] == "p" and toks[-1][1] == "!":
            toks = toks[:-1]
        # strip `as Type`, `?? default`, `|| default` tails
        for k, t in enumerate(toks):
            if t[0] == "id" and t[1] == "as" and k > 0:
                toks = toks[:k]; break
            if t[0] == "p" and t[1] in ("??", "||") and k > 0:
                toks = toks[:k]; break
            if t[0] == "id" and t[1] == "or" and self.py and k > 0:
                toks = toks[:k]; break
        if toks and toks[0][0] == "id" and toks[0][1] == "await":
            toks = toks[1:]
        if not toks:
            return VD("empty expression")
        while toks[-1][0] == "p" and toks[-1][1] == "!":
            toks = toks[:-1]
        if len(toks) >= 2 and toks[0][1] == "(" and self._match_in(toks, 0) == len(toks) - 1:
            return self.eval(toks[1:-1], scope)
        # concatenation a + b
        parts, cur, depth = [], [], 0
        for t in toks:
            if t[0] == "p" and t[1] in "([{":
                depth += 1
            elif t[0] == "p" and t[1] in ")]}":
                depth -= 1
            if depth == 0 and t[0] == "p" and t[1] == "+":
                parts.append(cur); cur = []
                continue
            cur.append(t)
        parts.append(cur)
        if len(parts) > 1:
            out = ()
            for p in parts:
                out += self.eval(p, scope)
            return vnorm(out)
        if len(toks) == 1:
            t = toks[0]
            if t[0] == "str":
                return VL(t[1]) if t[1] is not None else VD("template/f-string with interpolation")
            if t[0] == "id":
                if t[1] in scope:
                    return scope[t[1]]
                return VD("identifier %s not resolvable" % t[1])
            return VD("expression %s" % t[1])
        names = [t[1] for t in toks]
        s = "".join(str(x) for x in names)
        if s.startswith("process.env.") and len(toks) == 5 and toks[4][0] == "id":
            return (("E", toks[4][1]),)
        if s.startswith("process.env[") and len(toks) == 6 and toks[4][0] == "str":
            return (("E", toks[4][1]),)
        if s.startswith("process.argv[") and len(toks) == 6 and toks[4][0] == "num":
            k = int(toks[4][1]) - self.argv_offset
            return (("P", k),) if k >= 1 else VD("argv[%s]" % toks[4][1])
        if self.py:
            if s.startswith("sys.argv[") and len(toks) == 6 and toks[4][0] == "num":
                return (("P", int(toks[4][1])),)
            if re.match(r"^os\.(?:environ\.get|getenv)\(", s):
                k = next((j for j, t in enumerate(toks) if t[1] == "("), None)
                if k is not None and k + 1 < len(toks) and toks[k + 1][0] == "str":
                    return (("E", toks[k + 1][1]),)
            if s.startswith("os.environ[") and len(toks) >= 5 and toks[4][0] == "str":
                return (("E", toks[4][1]),)
        # call forms: join(a, b) / path.join / resolve / Path(x) / String(x) / os.path.join
        if toks[-1][1] == ")":
            k = 0
            while k < len(toks) and toks[k][1] != "(":
                k += 1
            if k < len(toks) and self._match_in(toks, k) == len(toks) - 1:
                fn = "".join(str(t[1]) for t in toks[:k])
                args = self._split_list(toks[k + 1:-1])
                base = fn.split(".")[-1]
                if base in ("join", "resolve", "Path", "PurePath"):
                    out = ()
                    for idx, a in enumerate(args):
                        v = self.eval(a, scope)
                        out += (VL("/") if idx and out else ()) + v
                    return vnorm(out)
                if fn in ("String", "str") and len(args) == 1:
                    return self.eval(args[0], scope)
                if base == "dirname" or fn == "fileURLToPath":
                    return VD("computed path (%s)" % fn)
        # python Path / "x"
        if self.py and any(t[0] == "p" and t[1] == "/" for t in toks):
            parts, cur = [], []
            for t in toks:
                if t[0] == "p" and t[1] == "/":
                    parts.append(cur); cur = []
                else:
                    cur.append(t)
            parts.append(cur)
            out = ()
            for idx, p in enumerate(parts):
                out += (VL("/") if idx else ()) + self.eval(p, scope)
            return vnorm(out)
        if len(toks) == 2 and toks[0][0] == "id" and toks[1][1] == "!":
            return self.eval(toks[:1], scope)
        return VD("expression `%s`" % " ".join(str(t[1]) for t in toks[:6]))

    def _match_in(self, toks, i):
        depth = 0
        for j in range(i, len(toks)):
            if toks[j][0] == "p" and toks[j][1] in "([{":
                depth += 1
            elif toks[j][0] == "p" and toks[j][1] in ")]}":
                depth -= 1
                if depth == 0:
                    return j
        return -1

    def _split_list(self, toks):
        out, cur, depth = [], [], 0
        for t in toks:
            if t[0] == "p" and t[1] in "([{":
                depth += 1
            elif t[0] == "p" and t[1] in ")]}":
                depth -= 1
            if depth == 0 and t[0] == "p" and t[1] == ",":
                out.append(cur); cur = []
                continue
            if t[0] != "nl":
                cur.append(t)
        if cur:
            out.append(cur)
        return out

    def _expect_in(self, lo, hi):
        """Expected anchor count enforced within token range [lo, hi)."""
        text = " ".join(str(t[1]) for t in self.toks[lo:hi] if t[0] != "str")
        m = re.search(r"(?:length - 1|\.count \(.*?\)|\b(?:count|matches|occurrences|hits|cnt|n|found|anchorCount|c))\s*(?:!==|!=|===|==)\s*(\d+)", text)
        if m:
            return ("exact", int(m.group(1)))
        if re.search(r"indexOf \( \w+ , \w+ \+ \w+ \. length \)", text) or re.search(r"\. find \( \w+ , \w+ \+", text):
            return ("exact", 1)
        return ("min", 1)

    # -- main analysis ---------------------------------------------------------
    def _analyse(self):
        toks = self.toks
        n = len(toks)
        # function ranges: (name, params, body_lo, body_hi)
        funcs = []
        for i, t in enumerate(toks):
            if self.py:
                if t[0] == "id" and t[1] == "def" and i + 2 < n and toks[i + 2][1] == "(":
                    close = self._match(i + 2, "(", ")")
                    params = [a[0][1] for a in self._split_list(toks[i + 3:close]) if a and a[0][0] == "id"]
                    # body: lines indented deeper than the `def` line
                    lines = self.text.split("\n")
                    dl = t[2] - 1
                    ind = len(lines[dl]) - len(lines[dl].lstrip()) if dl < len(lines) else 0
                    end_line = len(lines) + 1
                    for ln in range(dl + 1, len(lines)):
                        st = lines[ln]
                        if st.strip() and not st.strip().startswith("#") and len(st) - len(st.lstrip()) <= ind:
                            end_line = ln + 1
                            break
                    j = close + 1
                    while j < n and toks[j][2] < end_line:
                        j += 1
                    funcs.append((toks[i + 1][1], params, close + 1, j - 1))
                continue
            if t[0] == "id" and t[1] == "function" and i + 2 < n and toks[i + 1][0] == "id" and toks[i + 2][1] == "(":
                close = self._match(i + 2, "(", ")")
                params = [a[0][1] for a in self._split_list(toks[i + 3:close]) if a and a[0][0] == "id"]
                k = close + 1
                while k < n and toks[k][1] != "{":
                    k += 1
                funcs.append((toks[i + 1][1], params, k, self._match(k, "{", "}")))
            elif t[0] == "id" and t[1] in ("const", "let") and i + 3 < n and toks[i + 1][0] == "id" and toks[i + 2][1] == "=" and toks[i + 3][1] == "(":
                close = self._match(i + 3, "(", ")")
                if close + 1 < n and toks[close + 1][1] == "=>" or (close + 3 < n and toks[close + 1][1] == ":" ):
                    k = close + 1
                    while k < n and toks[k][1] != "=>" and k < close + 6:
                        k += 1
                    if k < n and toks[k][1] == "=>":
                        params = [a[0][1] for a in self._split_list(toks[i + 4:close]) if a and a[0][0] == "id"]
                        if k + 1 < n and toks[k + 1][1] == "{":
                            funcs.append((toks[i + 1][1], params, k + 1, self._match(k + 1, "{", "}")))
                        else:
                            funcs.append((toks[i + 1][1], params, k + 1, self._expr_end(k + 1)))
        self.funcs = funcs

        fidx = [None] * (n + 1)
        for f in sorted(funcs, key=lambda f: f[2]):
            for k in range(max(0, f[2]), min(n, f[3] + 1)):
                fidx[k] = f

        def scope_of(i):
            return fidx[i] if 0 <= i < n else None

        # pass 1: file-level + per-function bindings (sequential, first-binding wins on conflict -> D)
        file_scope = {}
        fscopes = {f[0]: {p: (("F", k),) for k, p in enumerate(f[1])} for f in funcs}
        srcvars = {}      # (funcname|None, var) -> target Value
        tables = []       # [before, after] pairs

        def bind(scope, name, v):
            if name in scope and scope[name] != v and scope[name][0][0] != "F":
                scope[name] = VD("%s reassigned" % name)
            elif name not in scope or scope[name][0][0] != "F":
                scope[name] = v

        i = 0
        while i < n:
            t = toks[i]
            f = scope_of(i)
            scope = fscopes[f[0]] if f else file_scope
            # tables: `key: [STR, STR]` / `[STR, STR]` inside a list
            if t[0] == "p" and t[1] == "[" and i + 4 < n and toks[i + 1][0] == "str" and toks[i + 2][1] == "," and toks[i + 3][0] == "str" and (toks[i + 4][1] == "]" or (toks[i + 4][1] == "," and i + 5 < n and toks[i + 5][1] == "]")):
                prev = toks[i - 1][1] if i else ""
                if prev in (":", ",", "[", "(", "="):
                    key = toks[i - 2][1] if prev == ":" and i >= 2 and toks[i - 2][0] in ("str", "id") else None
                    tables.append((key, toks[i + 1][1], toks[i + 1][2]))
            # JS declarations
            decl = None
            if not self.py and t[0] == "id" and t[1] in ("const", "let", "var"):
                decl = i + 1
            elif self.py and t[0] == "id" and (i == 0 or toks[i - 1][0] == "nl" or (toks[i - 1][0] == "p" and toks[i - 1][1] in (":", ";"))):
                decl = i
            if decl is not None and decl < n:
                look = dict(file_scope)
                look.update(scope)
                # destructuring  const [a, b] = X   /  a, b = X, Y
                if toks[decl][1] == "[" and not self.py:
                    close = self._match(decl, "[", "]")
                    names = [a[0][1] if a else None for a in self._split_list(toks[decl + 1:close])]
                    if close + 1 < n and toks[close + 1][1] == "=":
                        end = self._expr_end(close + 2)
                        rhs = toks[close + 2:end]
                        rs = "".join(str(x[1]) for x in rhs)
                        mm = re.match(r"process\.argv\.slice\((\d+)\)$", rs)
                        for k, nm in enumerate(names):
                            if not nm:
                                continue
                            if mm:
                                bind(scope, nm, (("P", int(mm.group(1)) + k + 1 - self.argv_offset - 1),))
                            elif rs and re.match(r"^\w+\[\w+\]$", rs):
                                bind(scope, nm, (("T", k, self.eval(rhs[2:3], look)),))
                            elif rs and re.match(r"^\w+$", rs) and look.get(rs, ((None,),))[0][0] == "K":
                                bind(scope, nm, (("T", k, look[rs][0][1]),))
                            else:
                                bind(scope, nm, VD("destructured %s" % rs[:30]))
                        i = end; continue
                elif self.py and toks[decl][0] == "id":
                    # a, b = X, Y   /  a = X
                    j = decl
                    names = []
                    while j < n and toks[j][0] == "id" and (j + 1 < n and toks[j + 1][1] in (",", "=")):
                        names.append(toks[j][1])
                        if toks[j + 1][1] == "=":
                            j += 1; break
                        j += 2
                    if names and j < n and toks[j][1] == "=" and (j + 1 < n and toks[j + 1][1] != "="):
                        end = self._expr_end(j + 1)
                        rhs = toks[j + 1:end]
                        while end < n and toks[end][1] == ",":
                            e2 = self._expr_end(end + 1)
                            rhs = rhs + [toks[end]] + toks[end + 1:e2]
                            end = e2
                        vals = self._split_list(rhs)
                        rs = "".join(str(x[1]) for x in rhs)
                        mm = re.match(r"sys\.argv\[(\d+):(\d*)\]$", rs)
                        for k, nm in enumerate(names):
                            if mm:
                                bind(scope, nm, (("P", int(mm.group(1)) + k),))
                            elif len(vals) == len(names):
                                v = self._value_or_src(vals[k], look, srcvars, f, nm)
                                if v is not None:
                                    bind(scope, nm, v)
                            elif len(names) > 1 and re.match(r"^\w+\[\w+\]$", rs):
                                bind(scope, nm, (("T", k, self.eval(rhs[2:3], look)),))
                        i = end; continue
                elif toks[decl][0] == "id" and decl + 1 < n and toks[decl + 1][1] in ("=", ":"):
                    nm = toks[decl][1]
                    j = decl + 1
                    if toks[j][1] == ":":       # TS type annotation
                        while j < n and toks[j][1] != "=" and toks[j][1] != ";":
                            j += 1
                    if j < n and toks[j][1] == "=":
                        end = self._expr_end(j + 1)
                        v = self._value_or_src(toks[j + 1:end], look, srcvars, f, nm)
                        if v is not None:
                            bind(scope, nm, v)
                        i = j + 1; continue
            i += 1

        # writes: a use only counts when the same file is written back (a mutation, not an assertion)
        writes = set()
        for i, t in enumerate(toks):
            if t[0] != "id" or i + 1 >= n or toks[i + 1][1] != "(":
                continue
            f = scope_of(i)
            look = None
            if t[1] in ("writeFileSync", "writeFile") or (t[1] == "write" and i >= 2 and toks[i - 2][1] == "Bun"):
                close = self._match(i + 1, "(", ")")
                a = self._split_list(toks[i + 2:close])
                if a:
                    look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                    writes.add(self.eval(a[0], look))
            elif self.py and t[1] == "write_text" and i >= 2 and toks[i - 1][1] == ".":
                look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                v = self._py_reader_target(i - 2, look, srcvars, f)
                if v is not None:
                    writes.add(v)
            elif self.py and t[1] == "open":
                close = self._match(i + 1, "(", ")")
                a = self._split_list(toks[i + 2:close])
                if len(a) >= 2 and a[1] and a[1][0][0] == "str" and a[1][0][1] and "w" in a[1][0][1]:
                    look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                    writes.add(self.eval(a[0], look))
        self.writes = writes

        # pass 2: needle uses
        for i, t in enumerate(toks):
            if not (t[0] == "p" and t[1] in (".", "?.")) or i + 2 >= n or toks[i + 1][0] != "id":
                if self.py and t[0] == "id" and t[1] == "in" and i > 0 and i + 1 < n and toks[i + 1][0] == "id":
                    f = scope_of(i)
                    key = (f[0] if f else None, toks[i + 1][1])
                    tgt = srcvars.get(key) or srcvars.get((None, toks[i + 1][1]))
                    if tgt is not None and toks[i - 1][1] == "not":
                        k = i - 2
                        look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                        self._add(toks[k:k + 1], look, tgt, f, i, tables, "in")
                continue
            meth = toks[i + 1][1]
            if meth not in (_NEEDLE_METHODS_PY if self.py else _NEEDLE_METHODS_JS) or toks[i + 2][1] != "(":
                continue
            f = scope_of(i)
            recv = toks[i - 1]
            tgt = None
            if recv[0] == "id":
                tgt = srcvars.get((f[0] if f else None, recv[1])) or srcvars.get((None, recv[1]))
            elif recv[1] == ")":
                # readFileSync(x, "utf8").split(...)   /  Path(x).read_text().count(...)
                depth, k = 0, i - 1
                while k >= 0:
                    if toks[k][1] == ")":
                        depth += 1
                    elif toks[k][1] == "(":
                        depth -= 1
                        if depth == 0:
                            break
                    k -= 1
                if k > 0 and toks[k - 1][0] == "id":
                    fn = toks[k - 1][1]
                    look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                    if fn in _READERS_JS:
                        args = self._split_list(toks[k + 1:i - 1])
                        if args:
                            tgt = self.eval(args[0], look)
                    elif fn in ("read_text", "read") and k > 2 and toks[k - 2][1] == ".":
                        tgt = self._py_reader_target(k - 3, look, srcvars, f)
            if tgt is None:
                continue
            close = self._match(i + 2, "(", ")")
            args = self._split_list(toks[i + 3:close])
            if not args:
                continue
            if meth == "includes" and not self._negated(i):
                continue      # `if (src.includes(MARKER)) exit` asserts ABSENCE -- not an anchor
            look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
            self._add(args[0], look, tgt, f, i, tables, meth)

        # python: re.sub(PAT, REPL, SRC, flags=...) / re.subn(...)
        if self.py:
            for i in range(n - 3):
                if toks[i][1] == "re" and toks[i + 1][1] == "." and toks[i + 2][1] in ("sub", "subn") and toks[i + 3][1] == "(":
                    close = self._match(i + 3, "(", ")")
                    a = self._split_list(toks[i + 4:close])
                    if len(a) < 3 or len(a[2]) != 1 or a[2][0][0] != "id":
                        continue
                    f = scope_of(i)
                    tgt = srcvars.get((f[0] if f else None, a[2][0][1])) or srcvars.get((None, a[2][0][1]))
                    if tgt is None or tgt not in writes:
                        continue
                    look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                    fl = "".join(x[1] for x in toks[i + 4:close] if x[0] == "id" and x[1] in ("M", "S", "I", "X", "MULTILINE", "DOTALL", "IGNORECASE", "VERBOSE"))
                    flags = "".join(sorted({"M": "m", "S": "s", "I": "i", "X": "x"}[c[0]] for c in re.findall(r"MULTILINE|DOTALL|IGNORECASE|VERBOSE|[MSIX]", fl)))
                    u = Use("py-regex", "pyre:" + flags, self.eval(a[0], look), tgt, ("min", 1), (self.file, toks[i][2]), ctx=self.ctx, flags=f[0] if f else "")
                    self.uses.append(u)

        # pass 3: wrapper call sites  NAME(args)
        wrappers = {}
        for u in self.uses:
            fn = u.flags
            if fn and any(s[0] == "F" for s in (u.needle or ()) + (u.target or ()) + (u.cwd or ())):
                wrappers.setdefault(fn, []).append(u)
        for _round in range(3):
            new = []
            for i, t in enumerate(toks):
                if t[0] != "id" or t[1] not in wrappers or i + 1 >= n or toks[i + 1][1] != "(":
                    continue
                if i > 0 and toks[i - 1][1] in ("function", "def", "."):
                    continue
                f = scope_of(i)
                if f and f[0] == t[1]:
                    continue
                close = self._match(i + 1, "(", ")")
                look = dict(file_scope); look.update(fscopes[f[0]] if f else {})
                argv = [self.eval(a, look) for a in self._split_list(toks[i + 2:close])]
                for w in wrappers[t[1]]:
                    u = w.inst(fargs=argv, via=(self.file, t[2]))
                    u.flags = f[0] if f else ""
                    new.append(u)
            self.uses = [u for u in self.uses if not (u.flags in wrappers and any(s[0] == "F" for s in (u.needle or ()) + (u.target or ())))]
            if not new:
                break
            self.uses.extend(new)
            wrappers = {}
            for u in new:
                if u.flags and any(s[0] == "F" for s in (u.needle or ()) + (u.target or ())):
                    wrappers.setdefault(u.flags, []).append(u)
            if not wrappers:
                break
        self.shape_unknown = not self.uses and any(v in writes for v in srcvars.values())
        # drop wrapper uses never called (F still present) -- they are definitions, not anchors
        self.uses = [u for u in self.uses if not any(s[0] == "F" for s in (u.needle or ()) + (u.target or ()))]
        for u in self.uses:
            u.flags = ""

    def _negated(self, i):
        """is the receiver expression ending before token i preceded by `!`?"""
        k = i - 1
        if self.toks[k][1] == ")":
            depth = 0
            while k >= 0:
                if self.toks[k][1] == ")":
                    depth += 1
                elif self.toks[k][1] == "(":
                    depth -= 1
                    if depth == 0:
                        break
                k -= 1
            k -= 1
        while k > 0 and self.toks[k - 1][1] == ".":
            k -= 2
        return k > 0 and self.toks[k - 1][1] == "!"

    def _py_reader_target(self, k, look, srcvars, f):
        """tokens ending at index k are the receiver of .read_text() / .read()"""
        t = self.toks[k]
        if t[0] == "id":
            return look.get(t[1]) if look.get(t[1]) is not None else None
        if t[1] == ")":
            depth, j = 0, k
            while j >= 0:
                if self.toks[j][1] == ")":
                    depth += 1
                elif self.toks[j][1] == "(":
                    depth -= 1
                    if depth == 0:
                        break
                j -= 1
            if j > 0 and self.toks[j - 1][0] == "id" and self.toks[j - 1][1] in ("Path", "open"):
                args = self._split_list(self.toks[j + 1:k])
                return self.eval(args[0], look) if args else None
        return None

    def _value_or_src(self, rhs, look, srcvars, f, name):
        """Bind `name = rhs`: either a reader (source var) or a plain value."""
        rhs = [t for t in rhs if t[0] != "nl"]
        if rhs and rhs[0][1] == "await":
            rhs = rhs[1:]
        if len(rhs) == 4 and rhs[0][0] == "id" and rhs[1][1] == "[" and rhs[2][0] in ("id", "str") and rhs[3][1] == "]":
            return (("K", self.eval(rhs[2:3], look)),)
        if not self.py and len(rhs) >= 9 and [t[1] for t in rhs[:4]] == ["Bun", ".", "file", "("]:
            close = self._match_in(rhs, 3)
            if [str(t[1]) for t in rhs[close + 1:]] == [".", "text", "(", ")"]:
                args = self._split_list(rhs[4:close])
                if args:
                    srcvars[(f[0] if f else None, name)] = self.eval(args[0], look)
                return VD("file contents")
        s = [t[1] for t in rhs]
        for k, t in enumerate(rhs):
            if t[0] == "id" and t[1] in _READERS_JS and k + 1 < len(rhs) and rhs[k + 1][1] == "(" and not self.py:
                close = self._match_in(rhs, k + 1)
                tail = "".join(str(x[1]) for x in rhs[close + 1:])
                head_ok = k <= 4 and all(x[0] == "id" or x[1] == "." for x in rhs[:k])
                if head_ok and tail in ("", ".toString()", ".trim()"):
                    args = self._split_list(rhs[k + 2:close])
                    if args:
                        srcvars[(f[0] if f else None, name)] = self.eval(args[0], look)
                return VD("file contents")
        if self.py and len(s) >= 4 and s[-3:] == [".", "read_text", "("] + [] or (self.py and "read_text" in s or self.py and s[-3:] == ["read", "(", ")"]):
            for k, t in enumerate(rhs):
                if t[1] in ("read_text", "read") and k >= 2 and rhs[k - 1][1] == ".":
                    sv = self._py_reader_target_in(rhs, k - 2, look)
                    if sv is not None:
                        srcvars[(f[0] if f else None, name)] = sv
                    return VD("file contents")
        return self.eval(rhs, look)

    def _py_reader_target_in(self, toks, k, look):
        t = toks[k]
        if t[0] == "id":
            return look.get(t[1])
        if t[1] == ")":
            depth, j = 0, k
            while j >= 0:
                if toks[j][1] == ")":
                    depth += 1
                elif toks[j][1] == "(":
                    depth -= 1
                    if depth == 0:
                        break
                j -= 1
            if j > 0 and toks[j - 1][0] == "id" and toks[j - 1][1] in ("Path", "open"):
                args = self._split_list(toks[j + 1:k])
                return self.eval(args[0], look) if args else None
        return None

    def _add(self, arg_toks, look, tgt, f, i, tables, meth=""):
        # a mutation writes back: same file, or (replace/split) the mutated text goes to some file
        soft = tgt not in self.writes
        if soft and not (meth in ("replace", "replaceAll", "split") and self.writes):
            return
        if arg_toks and arg_toks[0][0] == "re":
            r = arg_toks[0]
            needle, kind, flags = VL(r[1]), "jsre", r[3]
        else:
            needle, kind, flags = self.eval(arg_toks, look), "lit", ""
        lo, hi = (f[2], f[3]) if f else (max(0, i - 60), min(len(self.toks), i + 60))
        exp = self._expect_in(lo, hi) if kind == "lit" else ("min", 1)
        origin = (self.file, self.toks[i][2])
        if needle and needle[0][0] == "T":
            if needle[0][1] != 0 or not tables:
                return
            tid = len(TABLES)
            TABLES.append([(k, b, (self.file, ln)) for k, b, ln in tables])
            u = Use("%s-table" % self.lang, "lit", (("T", 0, needle[0][2], tid),), tgt, exp, origin, ctx=self.ctx)
            u.flags = f[0] if f else ""
            u.soft = soft
            self.uses.append(u)
            return
        u = Use(self.lang, kind, needle, tgt, exp, origin, ctx=self.ctx, flags=f[0] if f else "")
        u.soft = soft
        if kind == "jsre":
            u.form = self.lang + "-regex"
            u.kind = "jsre:" + flags
            u.flags = f[0] if f else ""
        self.uses.append(u)


# ───────────────────────────── shell analysis ────────────────────────────────
_CMDSUB_INTERESTING = re.compile(r"\b(?:sed|perl|bun|node|tsx|python3?|grep|deno|npx)\b|mutat")
_FUNC_DEF = re.compile(r"^(\s*)(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\)\s*\{?\s*(?:#.*)?$")
_FUNC_DEF_KW = re.compile(r"^(\s*)function\s+([A-Za-z_][\w:.-]*)\s*\{\s*$")
_FUNC_ONELINE = re.compile(r"^(\s*)(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\)\s*\{.*\}\s*;?\s*(?:#.*)?$")
_KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "exec",
             "command", "builtin", "nohup", "fi", "done", "esac", "in", "eval"}
_INTERP_JS = {"bun", "node", "tsx", "deno", "bunx"}
_INTERP_PY = {"python3", "python"}
_INTERP_SH = {"bash", "sh", "zsh"}


class ShellFile:
    def __init__(self, gate, rel, text):
        self.gate, self.rel, self.text = gate, rel, text
        self.ctx = os.path.join(gate.root, os.path.dirname(rel))
        self.lines = text.split("\n")
        self.funcs = {}        # name -> (lo, hi)   1-based inclusive line range
        self.own = {}          # scope(None|func) -> [Use]
        self.calls = {}        # scope -> [(callee, args, env, line, cwd)]
        self.sources = []      # sourced files (rel)
        self.shift = {}        # func -> shift N before "$@" exec
        self.vfiles = {}       # virtual files written via cat > PATH <<EOF
        self.aliases = []      # (scope, vdesc(dst), src Value) from `cp SRC DST`
        self._scope = None
        self._func_ranges()

    def _func_ranges(self):
        L = self.lines
        for idx, ln in enumerate(L):
            m = _FUNC_ONELINE.match(ln)
            if m and ln.rstrip().endswith("}"):
                self.funcs.setdefault(m.group(2), (idx + 1, idx + 1))
                continue
            m = _FUNC_DEF.match(ln) or _FUNC_DEF_KW.match(ln)
            if not m:
                continue
            ind = m.group(1)
            end = None
            close = re.compile("^" + re.escape(ind) + r"\}\s*(?:[;#].*)?$")
            for j in range(idx + 1, len(L)):
                if close.match(L[j]):
                    end = j + 1; break
            if end:
                self.funcs.setdefault(m.group(2), (idx + 1, end))

    def scope_at(self, line):
        best = None
        for name, (lo, hi) in self.funcs.items():
            if lo <= line <= hi and (best is None or lo >= self.funcs[best][0]):
                best = name
        return best

    # -- words -> values -------------------------------------------------------
    def wval(self, word, vars_):
        out = []
        for p in word:
            if p[0] == "L":
                out.append(("L", p[1]))
            elif p[0] == "V":
                name, rest = p[1], p[2]
                if name.isdigit():
                    if rest and not rest.startswith((":?", "?")):
                        out.append(("D", "${%s%s}" % (name, rest)))
                    else:
                        out.append(("P", int(name)))
                elif name in vars_ and (not rest or rest.startswith((":-", "-", ":?", "?", ":=", "="))):
                    out.extend(vars_[name])
                elif rest.startswith((":-", "-", ":=", "=")) and name not in vars_:
                    # unset in the script: the default is what the suite runs with
                    dflt = rest[2:] if rest.startswith((":-", ":=")) else rest[1:]
                    parsed = sh_parse(dflt) if dflt.strip() else []
                    words = parsed[0].words if len(parsed) == 1 else []
                    if len(words) == 1:
                        out.extend(self.wval(words[0], vars_))
                    else:
                        out.append(("E", name))
                elif rest and not rest.startswith((":?", "?")):
                    out.append(("D", "${%s%s}" % (name, rest[:20])))
                elif re.match(r"[A-Za-z_]", name):
                    out.append(("E", name))
                else:
                    out.append(("D", "$" + name))
            elif p[0] == "C":
                lit = _heredoc_literal(p[1])
                out.append(("L", lit) if lit is not None else ("D", "command substitution"))
        return self._alias(vnorm(out))

    def _alias(self, v):
        """`cp SRC DST` earlier in this file: DST (or DST/...) means SRC (or SRC/...)."""
        if not self.aliases:
            return v
        d = vdesc(v)
        for sc, dk, src in reversed(self.aliases):
            if sc != self._scope and (sc is not None or "$" in dk and re.search(r"\$\d", dk)):
                continue
            if d == dk:
                return src
            if d.startswith(dk + "/") and v[-1][0] == "L" and v[-1][1].endswith(d[len(dk):]):
                return vnorm(tuple(src) + VL(d[len(dk):]))
        return v

    # -- analysis --------------------------------------------------------------
    def analyse(self):
        cmds = sh_parse(self.text)
        gvars = {}
        fvars = {}
        gall = {}
        cwd = {None: None}
        for c in cmds:
            self._cmd(c, gvars, fvars, gall, cwd)

    def _vars_for(self, scope, gvars, fvars, gall):
        if scope is None:
            return gvars
        d = {}
        for k, vals in gall.items():
            if len(set(vals)) == 1:
                d[k] = vals[0]
            else:
                d[k] = VD("$%s assigned %d different values" % (k, len(set(vals))))
        d.update(fvars.setdefault(scope, {}))
        return d

    def _cmd(self, c, gvars, fvars, gall, cwd, line_override=None):
        line = line_override or c.line
        scope = self.scope_at(line)
        self._scope = scope
        words = list(c.words)
        # strip `name()` `{` of one-line functions and leading keywords
        if words and words[0] and words[0][-1] == ("L", "()"):
            words = words[1:]
        while words and len(words[0]) == 1 and words[0][0][0] == "L" and words[0][0][1] in _KEYWORDS:
            words = words[1:]
        vars_ = self._vars_for(scope, gvars, fvars, gall)
        # recurse into command substitutions first
        for w in words:
            for p in w:
                if p[0] == "C" and _CMDSUB_INTERESTING.search(p[1]) and _heredoc_literal(p[1]) is None:
                    for sub in sh_parse(p[1], p[2]):
                        self._cmd(sub, gvars, fvars, gall, cwd, line_override=line)
        if not words:
            return
        # assignments / env prefix
        env = {}
        k = 0
        decl = False
        if len(words[0]) == 1 and words[0][0][0] == "L" and words[0][0][1] in ("local", "export", "readonly", "declare", "typeset"):
            decl = True
            k = 1
            while k < len(words) and words[k] and words[k][0][0] == "L" and words[k][0][1].startswith("-"):
                k += 1
        assigns = []
        while k < len(words):
            w = words[k]
            if w and w[0][0] == "L" and re.match(r"^[A-Za-z_][A-Za-z0-9_]*\+?=", w[0][1]):
                name, rest = w[0][1].split("=", 1)
                val = self.wval([("L", rest)] + list(w[1:]), vars_)
                assigns.append((name.rstrip("+"), val, w))
                k += 1
                continue
            if decl:
                k += 1
                continue
            break
        rest = words[k:]
        if not rest:
            for name, val, w in assigns:
                self._assign(scope, name, val, gvars, fvars, gall)
                # N=$(grep -Fc 'LIT' FILE) followed by a numeric comparison
                if len(w) >= 1 and w[-1][0] == "C":
                    self._grep_count_guard(name, w[-1][1], vars_, scope, line, cwd.get(scope))
            return
        for name, val, _ in assigns:
            env[name] = val
        head = self.wval(rest[0], vars_)
        hl = vlit(head)
        args = [self.wval(w, vars_) for w in rest[1:]]
        cur_cwd = cwd.get(scope) if cwd.get(scope) is not None else cwd.get(None)
        if hl is None:
            # "$@" executed after shift N (tests/lib/mutation-guard.sh `mutate`)
            if rest[0] and rest[0][0][0] == "V" and rest[0][0][1] == "@" and scope:
                self.shift.setdefault(scope, self._shift_before(scope, line))
            elif head and head[0][0] == "E" and len(head) > 1 and head[-1][0] == "L":
                # "$DIR/run-mutation.sh" style script call
                self._script_call(head, args, env, scope, line, cur_cwd, interp=None)
            return
        base = hl.rsplit("/", 1)[-1]
        if base == "cd" and args:
            cwd[scope] = args[0] if vlit(args[0]) != "-" else None
            return
        if base == "cp":
            pos = [a for a in args if not (vlit(a) or "x").startswith("-")]
            res = self.gate.res
            if len(pos) >= 2:
                dst = pos[-1]
                into_dir = len(pos) > 2 or vdesc(dst).endswith("/")
                for src in pos[:-1]:
                    d = vdesc(dst).rstrip("/") + "/" + os.path.basename(vdesc(src)) if into_dir else vdesc(dst)
                    symbolic = any(x[0] in ("P", "E") for x in src) and not any(x[0] == "D" for x in src)
                    if len(dst) == 1 and dst[0][0] in ("P", "E"):
                        continue          # `cp X "$2"` writes to the caller's path -- not a copy we follow
                    if res.resolve(dst, cur_cwd, self.ctx) is None and (
                            symbolic or res.resolve(src, cur_cwd, self.ctx) is not None
                            or res.resolve_dir(src, cur_cwd) is not None):
                        self.aliases.append((scope, d, src))
            return
        if base in ("source", ".") and args:
            self.sources.append(args[0])
            return
        if base in ("timeout",) and args:
            self._cmd_words(rest[2:], c, gvars, fvars, gall, cwd, line)
            return
        if base == "env":
            j = 1
            while j < len(rest) and rest[j] and rest[j][0][0] == "L" and (re.match(r"^[A-Za-z_]\w*=", rest[j][0][1]) or rest[j][0][1].startswith("-")):
                j += 1
            self._cmd_words(rest[j:], c, gvars, fvars, gall, cwd, line, env_words=rest[1:j])
            return
        if base in ("runuser", "sudo", "su"):
            return
        if base == "sed":
            self._redirected = any(vlit(self.wval(r, vars_)) not in ("/dev/null", "&1", "&2", "1", "2") for r in c.redirs)
            self._sed(rest, vars_, scope, line, cur_cwd)
            return
        if base == "perl":
            self._perl(rest, vars_, scope, line, cur_cwd)
            return
        if base in ("cat", "tee") and c.heredocs:
            tgt = None
            if base == "cat" and c.redirs:
                tgt = self.wval(c.redirs[-1], vars_)
            elif base == "tee" and args:
                tgt = args[-1]
            if tgt is not None and vlit(tgt) is not None:
                self.vfiles[vlit(tgt)] = c.heredocs[0][1]
            return
        if base in _INTERP_JS or base in _INTERP_PY or base in _INTERP_SH or base == "npx":
            self._interp(base, rest, args, env, vars_, scope, line, cur_cwd, c)
            return
        if base.endswith((".sh", ".mjs", ".js", ".ts", ".py", ".cjs", ".mts")) or "/" in hl:
            self._script_call(head, args, env, scope, line, cur_cwd, interp=None)
            return
        # shell function call (this file, sourced files, tests/lib)
        self.gate.pending_calls.append((self, scope, hl, args, env, line, cur_cwd))

    def _cmd_words(self, words, c, gvars, fvars, gall, cwd, line, env_words=None):
        nc = Cmd(c.line)
        nc.words = (list(env_words or []) + list(words))
        nc.heredocs, nc.redirs = c.heredocs, c.redirs
        self._cmd(nc, gvars, fvars, gall, cwd, line_override=line)

    def _shift_before(self, scope, line):
        lo, _ = self.funcs[scope]
        for ln in self.lines[lo - 1:line]:
            m = re.search(r"\bshift\s+(\d+)", ln)
            if m:
                return int(m.group(1))
            if re.search(r"\bshift\b", ln):
                return 1
        return 0

    def _assign(self, scope, name, val, gvars, fvars, gall):
        # keep distinct dynamic values distinct (two `$(mktemp)` are different files)
        val = tuple(("D", "$%s (%s)" % (name, s[1])) if s[0] == "D" and not s[1].startswith("$" + name + " ") else s for s in val)
        if scope is None:
            gvars[name] = val
            gall.setdefault(name, []).append(val)
        else:
            fvars.setdefault(scope, {})[name] = val

    def add_use(self, scope, u):
        self.own.setdefault(scope, []).append(u)

    def add_unchecked(self, line, reason):
        self.gate.unchecked.append(((self.rel, line), (), reason, self.rel))

    def _grep_count_guard(self, var, sub, vars_, scope, line, cwd):
        cmds = sh_parse(sub, line)
        if len(cmds) != 1:
            return
        ws = cmds[0].words
        if not ws or vlit(self.wval(ws[0], vars_)) != "grep":
            return
        opts = "".join(vlit(self.wval(w, vars_)) or "" for w in ws[1:] if (vlit(self.wval(w, vars_)) or "").startswith("-"))
        if "c" not in opts:
            return
        rest = [self.wval(w, vars_) for w in ws[1:] if not (vlit(self.wval(w, vars_)) or "x").startswith("-")]
        if len(rest) != 2:
            return
        expect = None
        for ln in self.lines[line - 1:line + 6]:
            m = re.search(r"\$\{?%s\}?\"?\s*(?:==|=|-eq|!=|-ne)\s*\"?(\d+)\b" % re.escape(var), ln)
            if m:
                expect = ("exact", int(m.group(1))); break
        if expect is None:
            return
        kind = "lit" if "F" in opts else ("ere" if "E" in opts else "bre")
        self.add_use(scope, Use("grep-count", kind, rest[0], rest[1], expect, (self.rel, line), cwd=cwd, ctx=self.ctx))

    def _sed(self, rest, vars_, scope, line, cwd):
        words = [self.wval(w, vars_) for w in rest[1:]]
        inplace, ere, scripts, files = False, False, [], []
        j = 0
        while j < len(words):
            w = words[j]
            lw = vlit(w)
            if lw is not None and lw.startswith("-") and len(lw) > 1:
                if lw.startswith("--in-place") or (not lw.startswith("--") and "i" in lw.lstrip("-").split(".")[0][:3] and re.match(r"^-[A-Za-z]*i", lw)):
                    inplace = True
                if lw in ("-E", "-r", "--regexp-extended") or re.match(r"^-[a-zA-Z]*[Er]", lw):
                    ere = True
                if lw in ("-e", "--expression"):
                    scripts.append(words[j + 1] if j + 1 < len(words) else VD("?")); j += 2; continue
                if lw.startswith("--expression="):
                    scripts.append(VL(lw.split("=", 1)[1])); j += 1; continue
                if re.match(r"^-[A-Za-z]*e$", lw) and "i" in lw:
                    inplace = True
                    scripts.append(words[j + 1] if j + 1 < len(words) else VD("?")); j += 2; continue
                if lw in ("-f", "--file"):
                    j += 2; continue
                j += 1
                continue
            if not scripts and not any(vlit(x) in ("-e",) for x in words[:j]):
                scripts.append(w)
            else:
                files.append(w)
            j += 1
        if not inplace:
            if not (self._redirected and files and "-n" not in [vlit(w) for w in words]):
                return
        if not files:
            self.add_unchecked(line, "sed -i without a target file")
            return
        for s in scripts:
            for f in files:
                # the script may still be symbolic ($2 of a helper); it is parsed once literal
                u = Use("sed", "sedscript-ere" if ere else "sedscript", s, f, ("min", 1), (self.rel, line), cwd=cwd, ctx=self.ctx)
                u.soft = not inplace
                self.add_use(scope, u)

    def _perl(self, rest, vars_, scope, line, cwd):
        words = [self.wval(w, vars_) for w in rest[1:]]
        inplace = slurp = False
        script, files = None, []
        j = 0
        while j < len(words):
            lw = vlit(words[j])
            if lw is not None and lw.startswith("-") and script is None:
                body = lw[1:]
                if "0" in body:
                    slurp = True
                if "i" in body.replace("0777", ""):
                    inplace = True
                if body.endswith("e") or lw == "-e":
                    script = words[j + 1] if j + 1 < len(words) else VD("?")
                    j += 2; continue
                j += 1; continue
            if script is not None:
                files.append(words[j])
            j += 1
        if not inplace or script is None:
            return
        for f in files:
            u = Use("perl", "perlscript", script, f, ("min", 1), (self.rel, line), cwd=cwd, ctx=self.ctx)
            u.flags = "0" if slurp else ""
            self.add_use(scope, u)

    def _interp(self, base, rest, args, env, vars_, scope, line, cwd, c):
        words = [self.wval(w, vars_) for w in rest[1:]]
        lang = "py" if base in _INTERP_PY else ("sh" if base in _INTERP_SH else "js")
        j = 0
        if base == "npx":
            while j < len(words) and (vlit(words[j]) or "").startswith("-"):
                j += 1
            if j < len(words) and vlit(words[j]) in ("tsx", "ts-node", "bun"):
                j += 1
            else:
                return
        if base == "bun" and j < len(words) and vlit(words[j]) in ("test", "install", "build", "x", "add", "pm", "link"):
            return
        if base == "bun" and j < len(words) and vlit(words[j]) == "run":
            j += 1
        if base == "deno" and j < len(words) and vlit(words[j]) == "run":
            j += 1
        while j < len(words):
            lw = vlit(words[j])
            if lw is None or not lw.startswith("-") or lw == "-":
                break
            if lw in ("-e", "--eval", "-p", "--print") and lang == "js" or lw == "-c" and lang in ("py", "sh"):
                code = vlit(words[j + 1]) if j + 1 < len(words) else None
                if code is None:
                    if j + 1 < len(words) and MARKER_RE.search(vdesc(words[j + 1])):
                        self.add_unchecked(line, "inline %s code is not a literal" % lang)
                    return
                self._inline(lang, code, words[j + 2:], env, scope, line, cwd, offset=0)
                return
            if lw in ("-r", "--require", "--import", "--preload", "--loader", "-m", "-W", "-X"):
                if lw == "-m":
                    return
                j += 2; continue
            j += 1
        if j >= len(words):
            if lang in ("py", "js") and c.heredocs:
                self._inline(lang, c.heredocs[0][1], [], env, scope, line, cwd, offset=1)
            return
        script = words[j]
        sargs = words[j + 1:]
        if vlit(script) == "-":
            if c.heredocs:
                self._inline(lang, c.heredocs[0][1], sargs, env, scope, line, cwd, offset=1)
            return
        self._script_call(script, sargs, env, scope, line, cwd, interp=lang)

    def _inline(self, lang, code, sargs, env, scope, line, cwd, offset):
        if lang == "sh":
            return
        s = Script(code, lang, self.rel, offset, self.ctx)
        if s.shape_unknown:
            self.add_unchecked(line, "inline %s mutator shape not recognised" % lang)
        # inline: shift lines to the host file
        for u in s.uses:
            u.origin = (self.rel, line + max(0, u.origin[1] - 1))
            iu = u.inst(args=sargs, env=env, via=None)
            iu.cwd = cwd
            iu.ctx = self.ctx
            iu.form = "inline-" + u.form
            self.add_use(scope, iu)

    def _script_call(self, script, sargs, env, scope, line, cwd, interp):
        self.gate.script_calls.append((self, scope, script, sargs, env, line, cwd, interp))


def _scan_delim(s, i, d):
    while i < len(s):
        if s[i] == "\\":
            i += 2; continue
        if s[i] == d:
            return i
        i += 1
    return len(s)


def _heredoc_literal(sub):
    m = re.match(r"^\s*cat\s*<<-?\s*(['\"]?)([A-Za-z_]\w*)\1\s*\n(.*?)\n\s*\2\s*$", sub, re.S)
    if not m:
        return None
    body = m.group(3)
    if not m.group(1) and re.search(r"[$`\\]", body):
        return None
    return body


def parse_perl_script(sl):
    """`s/PAT/REPL/flags` -> (PAT, flags) or (None, why)"""
    m = re.match(r"^\s*s(.)", sl)
    if not m:
        return None, "perl script is not a single s///"
    d = m.group(1)
    closing = {"{": "}", "(": ")", "[": "]", "<": ">"}.get(d, d)
    pat_end = _scan_delim(sl, m.end(), closing)
    pat = sl[m.end():pat_end]
    if closing != d:
        rest_s = sl[pat_end + 1:].lstrip()
        rclose = {"{": "}", "(": ")", "[": "]", "<": ">"}.get(rest_s[:1], rest_s[:1])
        re_end = _scan_delim(rest_s, 1, rclose)
        flags = re.match(r"[a-z]*", rest_s[re_end + 1:]).group(0)
    else:
        re_end = _scan_delim(sl, pat_end + 1, d)
        flags = re.match(r"[a-z]*", sl[re_end + 1:]).group(0)
    return pat, flags


def parse_sed_script(s):
    """sed script -> [(regex-pattern | None, why)]  for every address / s-pattern in it."""
    out = []
    i, n = 0, len(s)
    while i < n:
        while i < n and s[i] in " \t\n;":
            i += 1
        if i >= n:
            break
        c = s[i]
        if c == "/" or c == "\\":
            d = "/" if c == "/" else s[i + 1]
            st = i + 1 if c == "/" else i + 2
            e = _scan_delim(s, st, d)
            out.append((s[st:e], ""))
            i = e + 1
            if i < n and s[i] == ",":
                i += 1
                if i < n and s[i] == "/":
                    e = _scan_delim(s, i + 1, "/")
                    out.append((s[i + 1:e], ""))
                    i = e + 1
                    continue
                out.append((None, "address range to a line number"))
                return out
            continue
        m = re.match(r"\d+,(?=/)", s[i:])
        if m:                       # GNU `0,/re/` (first match only): the regex is the anchor
            i += m.end()
            continue
        if c.isdigit() or c == "$":
            out.append((None, "line-number address"))
            return out
        if c == "s" and i + 1 < n:
            d = s[i + 1]
            e1 = _scan_delim(s, i + 2, d)
            e2 = _scan_delim(s, e1 + 1, d)
            if e1 > i + 2:           # `s//…/` reuses the previous regex
                out.append((s[i + 2:e1], ""))
            i = e2 + 1
            while i < n and s[i] not in ";\n}":
                i += 1
            continue
        if c in "{}!":
            i += 1; continue
        if c in "dpgGhHxnNDP=":
            i += 1; continue
        if c in "aic":
            # a\ text / c\ text: text runs to the first line not ending in a backslash
            while True:
                j = s.find("\n", i)
                if j < 0:
                    i = n
                    break
                cont = s[:j].endswith("\\")
                i = j + 1
                if not cont:
                    break
            continue
        out.append((None, "sed command %r" % c))
        return out
    return out


# ───────────────────────────────── the gate ──────────────────────────────────
class Gate:
    def __init__(self, root):
        self.root = root
        self.res = Resolver(root)
        self.shell = {}            # rel -> ShellFile
        self.scripts = {}          # rel -> Script (file mutators)
        self.unchecked = []        # (origin, via, reason, rootfile)
        self.pending_calls = []
        self.script_calls = []
        self.uses = []             # concrete uses, already instantiated
        self.recognised = set()
        self._cache = {}

    def tests_files(self):
        base = os.path.join(self.root, "tests")
        for dp, dns, fns in os.walk(base):
            dns[:] = [d for d in dns if d not in ("node_modules", ".git")]
            for fn in fns:
                yield os.path.relpath(os.path.join(dp, fn), self.root)

    def read(self, rel):
        if rel in self._cache:
            return self._cache[rel]
        try:
            with open(os.path.join(self.root, rel), encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            text = None
        self._cache[rel] = text
        return text

    def is_shell(self, rel, text):
        if rel.endswith((".sh", ".bash")):
            return True
        if "." not in os.path.basename(rel) and text.startswith("#!") and re.match(r"#!.*\b(ba|z)?sh\b", text):
            return True
        return False

    def script_file(self, rel, interp_lang):
        if rel in self.scripts:
            return self.scripts[rel]
        text = self.read(rel)
        if text is None:
            return None
        lang = interp_lang if interp_lang in ("js", "py") else ("py" if rel.endswith(".py") else "js")
        s = Script(text, lang, rel, 1, os.path.join(self.root, os.path.dirname(rel)))
        self.scripts[rel] = s
        return s

    def run(self):
        cand_shell, cand_other = [], []
        for rel in self.tests_files():
            ext = os.path.splitext(rel)[1]
            if ext in (".md", ".json", ".jsonl", ".txt", ".yml", ".yaml", ".diff", ".png", ".lock"):
                continue
            text = self.read(rel)
            if text is None:
                continue
            if self.is_shell(rel, text):
                if re.search(r"\bsed\b|\bperl\b|\bbun\b|\bnode\b|python|tsx|mutat|MUTATION|grep -\w*c", text):
                    cand_shell.append((rel, text))
            elif ext in (".ts", ".mjs", ".js", ".cjs", ".mts", ".py"):
                if MARKER_RE.search(text) or os.path.basename(rel).startswith("mutat"):
                    cand_other.append((rel, text))
        for rel, text in cand_shell:
            sf = ShellFile(self, rel, text)
            self.shell[rel] = sf
            sf.analyse()
        # resolve shell function calls -> (callee ShellFile, func)
        self.edges = {}       # (rel, scope) -> [(kind, target, args, env, line, cwd)]
        lib_funcs = {}
        for rel, sf in self.shell.items():
            for fn in sf.funcs:
                lib_funcs.setdefault(fn, []).append(rel)
        for sf, scope, name, args, env, line, cwd in self.pending_calls:
            target = None
            if name in sf.funcs:
                target = (sf.rel, name)
            else:
                for src in sf.sources:
                    r = self.res.resolve(src, cwd, sf.ctx)
                    if r and r in self.shell and name in self.shell[r].funcs:
                        target = (r, name); break
                if target is None and name in lib_funcs:
                    libs = [r for r in lib_funcs[name] if r.startswith("tests/lib/")]
                    if len(libs) == 1 and any("mutation-guard" in vdesc(s) or "lib/" in vdesc(s) for s in sf.sources):
                        target = (libs[0], name)
            if target:
                self.edges.setdefault((sf.rel, scope), []).append(("sh", target, args, env, line, cwd))
        # script calls
        invoked = set()
        for sf, scope, script, sargs, env, line, cwd, interp in self.script_calls:
            sl = vlit(script)
            if sl is not None and sl in sf.vfiles:
                lang = "py" if sl.endswith(".py") else "js"
                s = Script(sf.vfiles[sl], lang, sf.rel, 1, sf.ctx)
                for u in s.uses:
                    iu = u.inst(args=sargs, env=env, via=(sf.rel, line))
                    iu.cwd = cwd; iu.ctx = sf.ctx
                    sf.add_use(scope, iu)
                continue
            rel = self._resolve_script(script, sf, cwd)
            if rel is None:
                if sl is not None and re.search(r"mutat", sl, re.I):
                    self.unchecked.append(((sf.rel, line), (), "mutator script %s not found in the tree" % sl, sf.rel))
                continue
            invoked.add(rel)
            if rel in self.shell:
                self.edges.setdefault((sf.rel, scope), []).append(("sh", (rel, None), sargs, env, line, cwd))
            elif rel.endswith((".ts", ".mjs", ".js", ".cjs", ".mts", ".py")) and rel.startswith("tests/"):
                # only harness code under tests/ is a mutator; `bun agent-network/bin/cli.ts …` is the product
                self.edges.setdefault((sf.rel, scope), []).append(("script", rel, sargs, env, line, cwd))
                self.script_file(rel, interp)
        self.invoked = invoked
        # standalone script mutators under tests/ (never invoked from a shell we read)
        for rel, text in cand_other:
            s = self.script_file(rel, None)
            if s.uses:
                self.recognised.add(rel)
            if rel in invoked:
                continue
            for u in s.uses:
                self._final(u, rel, standalone=True)
            if s.shape_unknown or (not s.uses and os.path.basename(rel).startswith("mutat")):
                self.unchecked.append(((rel, 1), (), "mutator file shape not recognised", rel))
        # walk shell call graph from roots
        called = set()
        for (rel, scope), es in self.edges.items():
            for e in es:
                if e[0] == "sh":
                    called.add(e[1])
        for rel, sf in self.shell.items():
            if (rel, None) in called:
                # still harvest concrete uses
                for u in self.effective((rel, None), 0, frozenset()):
                    if self._concrete(u):
                        self._final(u, rel)
                continue
            for u in self.effective((rel, None), 0, frozenset()):
                self._final(u, rel)
            for fn in sf.funcs:
                if (rel, fn) in called:
                    continue
                for u in self.effective((rel, fn), 0, frozenset()):
                    if self._concrete(u):
                        self._final(u, rel)
        # harness files with markers + a write primitive that produced nothing
        produced = {u.origin[0] for u in self.uses} | {x[0][0] for x in self.unchecked} | self.recognised
        for u in self.uses:
            produced.update(v[0] for v in u.via)
        for rel, sf in self.shell.items():
            if rel in produced or not MARKER_RE.search(sf.text):
                continue
            if any(sf.own.get(k) for k in sf.own) or self.edges.get((rel, None)) or any(self.edges.get((rel, f)) for f in sf.funcs):
                continue
            if re.search(r"\bsed\s+(?:-\w+\s+)*-\w*i|\bperl\s+-\S*i\b", sf.text):
                self.unchecked.append(((rel, 1), (), "mutation harness shape not recognised", rel))
        return self

    def _resolve_script(self, script, sf, cwd):
        sl = vlit(script)
        if sl is not None:
            base = os.path.basename(sl)
            local = os.path.join(os.path.dirname(sf.rel), base)
            r = self.res.resolve(script, cwd, sf.ctx)
            if r:
                return r
            if self.res.isfile(local):
                return local
            return None
        r = self.res.resolve(script, cwd, sf.ctx)
        if r:
            return r
        tail = script[-1][1] if script and script[-1][0] == "L" else ""
        local = os.path.join(os.path.dirname(sf.rel), os.path.basename(tail))
        if tail.startswith("/") and self.res.isfile(local):
            return local
        return None

    def effective(self, key, depth, stack):
        """All uses reachable from callable `key` = (rel, scope), symbolic in its own params."""
        if depth > 6 or key in stack:
            return []
        rel, scope = key
        sf = self.shell.get(rel)
        out = list(sf.own.get(scope, [])) if sf else []
        for kind, tgt, args, env, line, cwd in self.edges.get(key, []):
            if kind == "sh":
                callee_rel, callee_scope = tgt
                csf = self.shell[callee_rel]
                shift = csf.shift.get(callee_scope) if callee_scope else None
                for u in self.effective(tgt, depth + 1, stack | {key}):
                    out.append(u.inst(args=args, env=env, cwd=cwd, via=(rel, line), ctx=sf.ctx))
                if shift is not None and len(args) > shift:
                    # mutate NAME FILE cmd... : interpret cmd... as a command at the call site
                    self._exec_tail(sf, scope, args[shift:], env, line, cwd, out)
            else:
                s = self.scripts.get(tgt)
                if s is None:
                    continue
                for u in s.uses:
                    out.append(u.inst(args=args, env=env, cwd=cwd, via=(rel, line), ctx=sf.ctx))
        return out

    def _exec_tail(self, sf, scope, vals, env, line, cwd, out):
        head = vlit(vals[0]) if vals else None
        if head is None:
            return
        tmp = ShellFile.__new__(ShellFile)
        tmp.__dict__.update(sf.__dict__)
        tmp.own = {}
        words = [[("L", vlit(v))] if vlit(v) is not None else [("V", "__dyn__", "")] for v in vals]
        c = Cmd(line)
        c.words = words
        tmp._cmd(c, {}, {}, {}, {None: cwd}, line_override=line)
        for us in tmp.own.values():
            out.extend(us)

    def _concrete(self, u):
        return vlit(u.needle) is not None and vlit(u.target) is not None

    def _final(self, u, rootfile, standalone=False):
        if u.needle and u.needle[0][0] == "T":
            _t, _col, key, tid = u.needle[0]
            entries = TABLES[tid]
            kl = vlit(key)
            if kl is not None:
                picked = [e for e in entries if e[0] == kl]
                if not picked:
                    self.unchecked.append((u.origin, u.via, "mode %r not in the mutator's table" % kl, rootfile))
                    return
            else:
                picked = entries      # mode chosen at run time (loop): every entry must apply
            for k, before, origin in picked:
                v = u.inst()
                v.needle, v.origin, v.rootfile = VL(before), origin, rootfile
                self._final(v, rootfile, standalone)
            return
        if vlit(u.needle) is None:
            self.unchecked.append((u.origin, u.via, "anchor is dynamic: " + vwhy(u.needle), rootfile))
            return
        if u.kind.startswith("sedscript"):
            for pat, why in parse_sed_script(vlit(u.needle)):
                if pat is None:
                    self.unchecked.append((u.origin, u.via, "sed script not understood: " + why, rootfile))
                    continue
                v = u.inst()
                v.needle, v.kind = VL(pat), ("ere" if u.kind.endswith("ere") else "bre")
                self._final(v, rootfile, standalone)
            return
        if u.kind == "perlscript":
            pat, flags = parse_perl_script(vlit(u.needle))
            if pat is None:
                self.unchecked.append((u.origin, u.via, flags, rootfile))
                return
            v = u.inst()
            v.needle, v.kind, v.flags = VL(pat), "perl", flags + u.flags
            self._final(v, rootfile, standalone)
            return
        tl = vlit(u.target)
        if u.soft and (u.target is None or self.res.resolve(u.target, u.cwd, u.ctx) is None):
            return
        if u.target is None:
            self.unchecked.append((u.origin, u.via, "target file unknown", rootfile))
            return
        if tl is None and not any(s[0] == "L" and s[1].startswith("/") for s in u.target):
            self.unchecked.append((u.origin, u.via, "target is dynamic: " + vwhy(u.target), rootfile))
            return
        u.rootfile = rootfile
        self.uses.append(u)


def _judge(gate, u):
    """-> (status, detail) with status in ok|dead|unchecked"""
    res = gate.res
    rel = res.resolve(u.target, u.cwd, u.ctx)
    if rel is None:
        return "unchecked", "target %s not resolvable to exactly one repo file" % vdesc(u.target)
    src = gate.read(rel)
    if src is None:
        return "unchecked", "target %s unreadable" % rel
    needle = vlit(u.needle)
    if u.kind == "lit":
        n = src.count(needle) if needle else 0
        if u.expect[0] == "exact":
            ok = n == u.expect[1]
            want = "== %d" % u.expect[1]
        else:
            ok = n >= 1
            want = ">= 1"
        return ("ok" if ok else "dead"), (rel, "count=%d (want %s)" % (n, want))
    if u.kind == "bre":
        rx = bre_to_regex(needle)
    elif u.kind == "ere":
        rx = ere_to_regex(needle)
    elif u.kind == "perl":
        rx = perl_to_regex(needle, u.flags, "0" in u.flags)
    elif u.kind.startswith("jsre"):
        fl = u.kind.split(":", 1)[1]
        rx = perl_to_regex(needle, fl.replace("g", "").replace("u", "").replace("y", ""), True)
    elif u.kind.startswith("pyre"):
        fl = u.kind.split(":", 1)[1]
        try:
            rx = re.compile(needle, (re.M if "m" in fl else 0) | (re.S if "s" in fl else 0) | (re.I if "i" in fl else 0) | (re.X if "x" in fl else 0))
        except re.error:
            rx = None
    else:
        rx = None
    if rx is None:
        return "unchecked", "regex not translatable (%s)" % u.kind
    ok = rx.search(src) is not None
    return ("ok" if ok else "dead"), (rel, "regex matched" if ok else "regex matched 0 times")


def scan(root):
    del TABLES[:]
    gate = Gate(root).run()
    seen, checked, dead, unchecked = set(), [], [], []
    forms = {}
    for u in gate.uses:
        status, detail = _judge(gate, u)
        if status == "unchecked":
            unchecked.append((u.origin, u.via, detail, u.rootfile))
            continue
        key = (detail[0], u.kind, vlit(u.needle), u.expect)
        if key in seen:
            continue
        seen.add(key)
        forms[u.form] = forms.get(u.form, 0) + 1
        checked.append((u, detail))
        if status == "dead":
            dead.append((u, detail))
    useen = set()
    for o, via, why, rootfile in gate.unchecked + unchecked:
        k = (o, via[-1] if via else None, why)
        if k in useen:
            continue
        useen.add(k)
        unchecked_entry = (o, via, why, rootfile)
        unchecked.append(unchecked_entry) if unchecked_entry not in unchecked else None
    # dedupe unchecked list
    final_unchecked, us = [], set()
    for o, via, why, rootfile in unchecked:
        k = (o, via[-1] if via else None, why)
        if k in us:
            continue
        us.add(k)
        final_unchecked.append((o, via, why, rootfile))
    return gate, checked, dead, final_unchecked, forms


def _where(u):
    s = "%s:%d" % u.origin
    if u.via:
        s += " (via " + ", ".join("%s:%d" % v for v in reversed(u.via)) + ")"
    return s


def load_baseline(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data
    except (OSError, ValueError):
        return None


def unchecked_by_file(unchecked):
    by = {}
    for o, via, why, rootfile in unchecked:
        f = rootfile or o[0]
        by[f] = by.get(f, 0) + 1
    return dict(sorted(by.items()))


def stale_key(u, rel):
    import hashlib
    return {"harness": u.origin[0], "target": rel,
            "anchor_sha1": hashlib.sha1(vlit(u.needle).encode("utf-8")).hexdigest()[:16],
            "anchor": vlit(u.needle)[:100]}


def _kid(k):
    return (k["harness"], k["target"], k["anchor_sha1"])


def main(argv) -> int:
    root = ROOT
    baseline_path = BASELINE_DEFAULT
    listing = "--list" in argv
    if "--root" in argv:
        k = argv.index("--root")
        if k + 1 >= len(argv):
            print("usage: --root DIR"); return 2
        root = os.path.abspath(argv[k + 1])
    if "--baseline" in argv:
        k = argv.index("--baseline")
        if k + 1 >= len(argv):
            print("usage: --baseline FILE"); return 2
        baseline_path = argv[k + 1]
    gate, checked, dead, unchecked, forms = scan(root)
    by = unchecked_by_file(unchecked)
    base = load_baseline(baseline_path)
    known = {_kid(k): k for k in (base or {}).get("known_stale", [])}
    dead_keys = [(u, d, stale_key(u, d[0])) for u, d in dead]
    new_dead = [(u, d, k) for u, d, k in dead_keys if _kid(k) not in known]
    old_dead = [(u, d, k) for u, d, k in dead_keys if _kid(k) in known]
    if "--write-baseline" in argv:
        if new_dead and "--accept-stale" not in argv:
            print("MUTATION-PIN: refusing to write a baseline over %d NEW dead anchor(s); fix them "
                  "(or, for a pre-existing break you are tracking in an issue, pass --accept-stale)" % len(new_dead))
            return 2
        stale = sorted({_kid(k): k for _u, _d, k in dead_keys}.values(), key=lambda k: (k["harness"], k["anchor"]))
        with open(baseline_path, "w", encoding="utf-8") as fh:
            json.dump({
                "_comment": "Ratchet for scripts/check-mutation-pins.py. `unchecked`: mutation anchors the gate cannot "
                            "resolve statically, per harness file -- may only go down. `known_stale`: anchors already "
                            "dead on main when this gate learned to see them; each one should be fixed and "
                            "removed, never added to. Regenerate with --write-baseline only after "
                            "REMOVING entries.",
                "unchecked": {"total": len(unchecked), "by_file": by},
                "known_stale": stale}, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print("MUTATION-PIN: wrote baseline %s (unchecked=%d, known_stale=%d)" % (
            os.path.relpath(baseline_path, ROOT), len(unchecked), len(stale)))
        return 0
    print("MUTATION-PIN: scanned %d shell file(s) + %d script mutator(s) under %s/tests" % (
        len(gate.shell), len(gate.scripts), root if root != ROOT else "."))
    print("MUTATION-PIN: checked %d distinct anchor(s) in %d form(s): %s" % (
        len(checked), len(forms), ", ".join("%s=%d" % kv for kv in sorted(forms.items()))))
    print("MUTATION-PIN: unchecked %d (dynamic or unresolvable -- listed and ratcheted, never dropped):" % len(unchecked))
    for o, via, why, rootfile in unchecked:
        w = "%s:%d" % o + ((" (via " + ", ".join("%s:%d" % v for v in reversed(via)) + ")") if via else "")
        print("    %s  %s" % (w, why))
    if listing:
        print("\n-- checked anchors --")
        for u, detail in checked:
            print("  [%s] %s -> %s  %s :: %s" % (u.form, _where(u), detail[0], detail[1],
                                                vlit(u.needle)[:90].replace("\n", "\\n")))
    rc = 0
    if old_dead:
        print("\nMUTATION-PIN: %d KNOWN-STALE anchor(s) (already dead on main, listed in the baseline; fix and remove):" % len(old_dead))
        for u, (rel, why), _k in old_dead:
            print("  ~ %s [%s] -> %s: %s" % (_where(u), u.form, rel, why))
    if new_dead:
        print("\nMUTATION-PIN: RED -- %d anchor(s) no longer apply:" % len(new_dead))
        for u, (rel, why), _k in new_dead:
            print("  X %s [%s]" % (_where(u), u.form))
            print("     target %s: %s" % (rel, why))
            print("     anchor: %s" % vlit(u.needle)[:160].replace("\n", "\\n"))
        print()
        print("FIX: the pinned source was refactored => that mutation is now a NOOP (or hits the wrong count),")
        print("     and the Docker suite will report MUTATION_NOOP / `anchor count=0` late in CI.")
        print("     Re-point the anchor at the new source text, keeping the mutation's meaning;")
        print("     do not loosen the assertion that follows it.")
        rc = 1
    fixed = [k for kid, k in known.items() if kid not in {_kid(x) for _u, _d, x in dead_keys}]
    if fixed and base is not None:
        print("\nMUTATION-PIN: %d known-stale anchor(s) apply again -- drop them with --write-baseline:" % len(fixed))
        for k in fixed:
            print("  + %s -> %s :: %s" % (k["harness"], k["target"], k["anchor"][:80]))
    if base is None:
        print("\nMUTATION-PIN: no baseline at %s -- ratchet not enforced" % baseline_path)
        return rc or 2
    ub = base.get("unchecked", {})
    bb = ub.get("by_file", {})
    over = [(f, c, bb.get(f, 0)) for f, c in by.items() if c > bb.get(f, 0)]
    if len(unchecked) > ub.get("total", 0) or over:
        print("\nMUTATION-PIN: RATCHET -- unchecked %d vs baseline %d" % (len(unchecked), ub.get("total", 0)))
        for f, c, b in over:
            print("  + %s: %d unchecked (baseline %d)" % (f, c, b))
        print("FIX: write the mutation so its anchor and target are literals this gate can read")
        print("     (CONTRIBUTING.md, \"Mutation anchors\"); do not raise the baseline.")
        rc = rc or 2
    elif len(unchecked) < ub.get("total", 0):
        print("\nMUTATION-PIN: unchecked dropped %d -> %d; lower the baseline with --write-baseline" % (
            ub.get("total", 0), len(unchecked)))
    if rc == 0:
        print("\nMUTATION-PIN: GREEN -- every checked anchor still hits its target; unchecked %d <= baseline %d." % (
            len(unchecked), ub.get("total", 0)))
    return rc


# ───────────────────────────────── selftest ──────────────────────────────────
_TMP_TREES = []


def _mk_tree(files):
    import tempfile
    d = tempfile.mkdtemp(prefix="mutpin-selftest-")
    _TMP_TREES.append(d)
    for rel, text in files.items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)
    return d


SRC_A = "export const DEFAULT_MODEL = \"gpt-x\";\nif (a && b) gen++;\nconst x = 1;\n"
FORM_CASES = {
    # form: (harness files, expected number of anchors collected)
    "sed": ({"tests/t1/run.sh": "#!/bin/bash\n# mutation\nsed -i 's/if (a \\&\\& b) gen++;/if (false) gen++;/' agent-node/src/a.ts\n"}, 1),
    "perl": ({"tests/t2/run.sh": "#!/bin/bash\n# mutation\nperl -0pi -e 's/if \\(a && b\\)/if (false)/' agent-node/src/a.ts\n"}, 1),
    "grep-count": ({"tests/t3/run.sh": "#!/bin/bash\nF=\"$ROOT/agent-node/src/a.ts\"\nC=$(grep -Fc 'const x = 1;' \"$F\")\n[[ \"$C\" == \"1\" ]] || exit 1\nsed -i 's/const x = 1;/const x = 2;/' \"$F\"\n"}, 2),
    "inline-python": ({"tests/t4/run.sh": "#!/bin/bash\nTARGET=$'if (a && b)'\npython3 - \"$ROOT/agent-node/src/a.ts\" \"$TARGET\" X <<'PY'\nfrom pathlib import Path\nimport sys\npath = Path(sys.argv[1])\nsource = path.read_text()\ntarget, replacement = sys.argv[2], sys.argv[3]\nif source.count(target) != 1:\n    raise SystemExit(\"mutation target count changed\")\npath.write_text(source.replace(target, replacement, 1))\nPY\n"}, 1),
    "run_mutation helper (inline bun -e env)": ({"tests/t5/run.sh": "#!/bin/bash\nrun_mutation() {\n  local name=$1 file=$2 from=$3 to=$4\n  MUTATION_FILE=\"$file\" MUTATION_FROM=\"$from\" MUTATION_TO=\"$to\" bun -e '\n    import { readFileSync, writeFileSync } from \"node:fs\";\n    const file = process.env.MUTATION_FILE!;\n    const from = process.env.MUTATION_FROM!;\n    const source = readFileSync(file, \"utf8\");\n    writeFileSync(file, source.replace(from, process.env.MUTATION_TO!));\n  '\n  echo MUTATION_NOOP\n}\nrun_mutation m1 \"$ROOT/agent-node/src/a.ts\" 'DEFAULT_MODEL = \"gpt-x\"' 'DEFAULT_MODEL = \"y\"'\n"}, 1),
    "mutate.ts FILE BEFORE AFTER (Dockerfile COPY + WORKDIR)": ({
        "tests/t6/Dockerfile": "FROM x\nWORKDIR /work/agent-node\nCOPY agent-node/src ./src\nCOPY tests/t6/m.ts /work/tests/mutate.ts\n",
        "tests/t6/m.ts": "import { readFileSync, writeFileSync } from \"fs\";\nconst [file, before, after] = process.argv.slice(2);\nconst source = readFileSync(file, \"utf8\");\nconst occurrences = source.split(before).length - 1;\nif (occurrences !== 1) throw new Error(`mutation anchor count=${occurrences}`);\nwriteFileSync(file, source.replace(before, after));\n",
        "tests/t6/run.sh": "#!/bin/bash\nbun /work/tests/mutate.ts src/a.ts 'if (a && b) gen++;' 'if (false) gen++;'\n"}, 1),
    "mode-table mutator": ({
        "tests/t7/mutate.mjs": "import { readFileSync, writeFileSync } from \"node:fs\";\nconst [mode, path] = process.argv.slice(2);\nconst mutations = {\n  \"m1\": [\"const x = 1;\", \"const x = 2;\"],\n  \"m2\": [\"if (a && b) gen++;\", \"if (false) gen++;\"],\n};\nconst pair = mutations[mode];\nconst source = readFileSync(path, \"utf8\");\nconst [anchor, replacement] = pair;\nif (source.split(anchor).length - 1 !== 1) throw new Error(\"x\");\nwriteFileSync(path, source.replace(anchor, replacement));\n",
        "tests/t7/run.sh": "#!/bin/sh\ncd /workspace/agent-node\nfor m in m1 m2; do node /workspace/tests/t7/mutate.mjs \"$m\" src/a.ts; done\n"}, 2),
    "wrapper fn + const path": ({
        "tests/t8/mutate.ts": "import { readFileSync, writeFileSync } from \"node:fs\";\nconst mutation = process.argv[2];\nconst aPath = \"./src/a.ts\";\nfunction replaceExact(path: string, before: string, after: string) {\n  const source = readFileSync(path, \"utf8\");\n  const matches = source.split(before).length - 1;\n  if (matches !== 1) throw new Error(\"x\");\n  writeFileSync(path, source.replace(before, after));\n}\nswitch (mutation) {\n  case \"a\":\n    replaceExact(aPath, \"const x = 1;\", \"const x = 2;\");\n    break;\n}\n",
        "tests/t8/run.sh": "#!/bin/bash\ncd /workspace/agent-node\nbun tests/t8/mutate.ts a\n"}, 1),
    "fixed needle + argv path": ({
        "tests/t9/mutate-x.mjs": "import { readFileSync, writeFileSync } from 'node:fs';\nconst p = process.argv[2];\nconst src = readFileSync(p, 'utf8');\nconst needle = 'const x = 1;';\nif (!src.includes(needle)) process.exit(1);\nwriteFileSync(p, src.replace(needle, 'const x = 3;'));\n",
        "tests/t9/run.sh": "#!/bin/bash\nnode tests/t9/mutate-x.mjs \"$ROOT/agent-node/src/a.ts\"\n"}, 1),
    "lib mutate NAME FILE cmd": ({
        "tests/lib/mutation-guard.sh": "mutate() {\n  local name=\"$1\" file=\"$2\"; shift 2\n  \"$@\"\n}\n",
        "tests/t10/run.sh": "#!/bin/bash\nsource \"$ROOT/tests/lib/mutation-guard.sh\"\nmutate m1 agent-node/src/a.ts perl -0pi -e 's/const x = 1;/const x = 2;/' agent-node/src/a.ts\n"}, 1),
    "run-mutation.sh script + heredoc literal": ({
        "tests/t11/run-mutation.sh": "#!/usr/bin/env bash\nfile=\"$1\"\nfrom=\"$2\"\npython3 - \"$file\" \"$from\" <<'PY'\nimport sys\nsrc = open(sys.argv[1]).read()\nassert src.count(sys.argv[2]) == 1\nopen(sys.argv[1], \"w\").write(src.replace(sys.argv[2], \"x\"))\nPY\n",
        "tests/t11/run.sh": "#!/bin/bash\n# mutation\nFROM=$(cat <<'EOF'\nif (a && b) gen++;\nEOF\n)\nbash tests/t11/run-mutation.sh agent-node/src/a.ts \"$FROM\"\n"}, 1),
}


def selftest() -> int:
    ok = fail = 0

    def ck(name, cond):
        nonlocal ok, fail
        print(f"  {'ok  ' if cond else 'FAIL'} {name}")
        ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)

    # ── criterion helpers (original selftest) ──
    ck("unescape \\. -> .", unescape(r"a\.b") == "a.b")
    ck("unescape \\[ -> [", unescape(r"args\[1\]") == "args[1]")
    ck("BRE: ? is literal", bool(bre_to_regex(r"a?.b").search("a?xb")))
    ck("BRE: \\. matches only a dot", bre_to_regex(r"a\.b").search("axb") is None)
    ck("BRE: . is meta", bool(bre_to_regex("a.b").search("axb")))
    ck("BRE: escaped [ is literal", bool(bre_to_regex(r"args\[1\]").search("args[1]")))
    ck("positive control: absent string is not found", bre_to_regex("zzz_not_here").search("hello") is None)
    ck("BRE: mid-pattern $ is literal (template strings)", bool(bre_to_regex("a${x}b").search("a${x}b")))
    ck("BRE: trailing $ is an anchor", bre_to_regex("ab$").search("abc") is None)
    ck("BRE: leading ^ is an anchor", bre_to_regex("^ab").search("xab") is None)
    ck("perl: (?:a|b) translates", bool(perl_to_regex(r"x(?:a|b)\n", "", True).search("xb\n")))
    ck("perl: \\Q is refused (unchecked, not guessed)", perl_to_regex(r"\Qa.b\E", "", True) is None)
    ck("same-named candidates are ambiguous (no guessing)", resolve_target("src/server.ts") is None)
    ck("a unique candidate resolves", resolve_target("agent-network/bin/cli.ts") is not None)
    ck("container path /workspace/x resolves", resolve_target("/workspace/agent-network/bin/cli.ts") == "agent-network/bin/cli.ts")
    ck("sed script: address + s///", [p for p, _ in parse_sed_script("/foo/s/a/b/")] == ["foo", "a"])
    ck("sed script: line address is refused", parse_sed_script("12d")[0][0] is None)

    # ── per form: (b) collection  (a) judge green  (a') judge red on a missing anchor ──
    for form, (files, want) in FORM_CASES.items():
        tree = dict(files)
        tree["agent-node/src/a.ts"] = SRC_A
        d = _mk_tree(tree)
        _g, checked, dead, unchecked, _f = scan(d)
        ck(f"collect [{form}]: {want} anchor(s) collected, got {len(checked)}; unchecked={len(unchecked)}",
           len(checked) == want and not unchecked)
        ck(f"judge   [{form}]: green on the live source (dead={len(dead)})", not dead and len(checked) == want)
        # the refactor that broke #2320 / #2325: the pinned text is gone
        with open(os.path.join(d, "agent-node/src/a.ts"), "w", encoding="utf-8") as fh:
            fh.write("export const DEFAULT_MODEL = pick();\nif (a) gen++;\nconst x = 9;\n")
        _g, checked2, dead2, _u, _f = scan(d)
        ck(f"judge   [{form}]: RED once the anchor is refactored away (dead={len(dead2)})", len(dead2) == want)
    # exact-count semantics: anchor present twice where the harness wants exactly one -> red
    d = _mk_tree({"agent-node/src/a.ts": SRC_A + "if (a && b) gen++;\n", **FORM_CASES["mutate.ts FILE BEFORE AFTER (Dockerfile COPY + WORKDIR)"][0]})
    ck("judge: exact-1 anchor duplicated -> red", len(scan(d)[2]) == 1)
    # ratchet: an unresolvable new harness is listed as unchecked, not dropped
    d = _mk_tree({"agent-node/src/a.ts": SRC_A,
                  "tests/t12/run.sh": "#!/bin/bash\n# mutation\nsed -i \"s/$PAT/x/\" agent-node/src/a.ts\n"})
    _g, c3, d3, u3, _f = scan(d)
    ck("ratchet: dynamic sed pattern counted as unchecked (%d)" % len(u3), len(u3) == 1 and not c3)
    d = _mk_tree({"agent-node/src/a.ts": SRC_A,
                  "tests/t13/run.sh": "#!/bin/bash\n# witnessed-red mutation\nperl -pi -e 'print \"x\"' agent-node/src/a.ts\n"})
    ck("ratchet: unrecognised harness surfaces as unchecked", len(scan(d)[3]) >= 1)
    # exit codes through main(): ratchet (2), known-stale (0), new dead (1)
    import contextlib
    import io

    def rc_of(argv):
        with contextlib.redirect_stdout(io.StringIO()):
            return main(argv)

    d = _mk_tree({"agent-node/src/a.ts": SRC_A,
                  "tests/t12/run.sh": "#!/bin/bash\n# mutation\nsed -i \"s/$PAT/x/\" agent-node/src/a.ts\n"})
    bl = os.path.join(d, "baseline.json")
    with open(bl, "w", encoding="utf-8") as fh:
        json.dump({"unchecked": {"total": 0, "by_file": {}}, "known_stale": []}, fh)
    ck("rc: unchecked above baseline -> 2", rc_of(["--root", d, "--baseline", bl]) == 2)
    with open(bl, "w", encoding="utf-8") as fh:
        json.dump({"unchecked": {"total": 1, "by_file": {"tests/t12/run.sh": 1}}, "known_stale": []}, fh)
    ck("rc: unchecked within baseline -> 0", rc_of(["--root", d, "--baseline", bl]) == 0)
    d = _mk_tree({"agent-node/src/a.ts": "nothing here\n", **FORM_CASES["sed"][0]})
    bl = os.path.join(d, "baseline.json")
    with open(bl, "w", encoding="utf-8") as fh:
        json.dump({"unchecked": {"total": 0, "by_file": {}}, "known_stale": []}, fh)
    ck("rc: new dead anchor -> 1", rc_of(["--root", d, "--baseline", bl]) == 1)
    ck("rc: --write-baseline refuses to absorb a new dead anchor -> 2",
       rc_of(["--root", d, "--baseline", bl, "--write-baseline"]) == 2)
    ck("rc: --write-baseline --accept-stale records it", rc_of(["--root", d, "--baseline", bl, "--write-baseline", "--accept-stale"]) == 0)
    ck("rc: a known-stale anchor does not fail -> 0", rc_of(["--root", d, "--baseline", bl]) == 0)
    # collection on the real tree: the denominator is not empty
    _g, checked, dead, unchecked, forms = scan(ROOT)
    ck("real tree: >= 150 anchors checked (got %d)" % len(checked), len(checked) >= 150)
    for f in ("sed", "perl", "inline-js", "inline-py", "js", "js-table", "grep-count"):
        ck("real tree: form %s collected (%d)" % (f, forms.get(f, 0)), forms.get(f, 0) >= 1)
    ck("real tree: test697 run_mutation anchors collected",
       any(u.origin[0].startswith("tests/test697") and u.via for u, _ in checked))
    ck("real tree: test-status-read-cache mutate.ts anchors collected",
       sum(1 for u, _ in checked if any(v[0].startswith("tests/test-status-read-cache") for v in u.via)) >= 4)
    import shutil
    for d in _TMP_TREES:
        shutil.rmtree(d, ignore_errors=True)
    print(f"selftest: {ok} ok / {fail} fail")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main(sys.argv[1:]))
