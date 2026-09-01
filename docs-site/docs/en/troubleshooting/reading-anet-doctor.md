# Reading `anet doctor` output

`anet doctor` is the first command for "is this machine OK right now". It looks only at
**this machine and the Hub it points at** — it never probes whether any node is alive.
For that, see [Is this node still alive](/en/troubleshooting/is-this-node-alive).

A real run (from a configured machine):

```
anet doctor — System Diagnostic

  ✅ Global config (~/.anet/config.json) (http://127.0.0.1:9200)
  ✅ Auth token configured
  ⚠  Package file modes: umask is 0002, so npm extracts packages group-writable …
  ✅ CommHub reachable (http://127.0.0.1:9200 v0.9.0-preview.38; this machine's anet hub start pins 0.9.0-preview.44)
  ℹ  API version: v3
  ℹ  Sessions: 271 registered
  ℹ  SSE connections: 127 active
  ✅ No plain-secret config (all env values are either non-secret or envRef objects)
  ✅ Claude Code CLI (2.1.251 (Claude Code))
  ✅ Codex CLI (codex-cli 0.149.1)
  ✅ Bun runtime (1.4.0)
  ✅ SkillHub catalog (7 skill(s) available …)

  Result: 9 ok, 3 warnings, 1 errors
```

## What the four prefixes mean

| Prefix | Meaning | Counted in the result line? |
| --- | --- | --- |
| ✅ | Judged, and it is good | counted in `ok` |
| ⚠ | Judged, not bad but worth knowing (e.g. a umask that makes npm extract packages group-writable) | counted in `warnings` |
| ❌ | Judged, and it is bad | counted in `errors` |
| ℹ | **A fact, stated without judgement** | **counted in none of them** |

🔴 **`ℹ` does not mean "fine" — it means this command is not judging that cell for you.**
For example `Sessions: 271 registered` says the roster holds 271 session rows. It does **not**
mean 271 nodes are alive; the roster carries a large number of offline rows at all times.

## The version lines report, they do not judge

```
✅ Claude Code CLI (2.1.251 (Claude Code))
✅ Codex CLI (codex-cli 0.149.1)
✅ Bun runtime (1.4.0)
```

🔴 **The parentheses hold the version actually installed. These lines make no
"new enough?" judgement.**

The reason is a measured one: `codex-cli 0.149.1` was **installed**, but could not decode a
reasoning-effort value it did not know in the upstream models response; the rmcp worker died
fatally and the user saw a 300s timeout — while doctor, which only checked *presence*, showed
a ✅.

So why not add a minimum-version check? Because "how new is new enough" is decided by what
upstream returns, not by a constant we can pin. A guessed floor turns into a false alarm the
next time someone upgrades the CLI or upstream shifts again — and a check that cries wolf gets
switched off in its first week. **Printing the actual version and letting the reader match it
up is all this cell can honestly do.**

⇒ When chasing an unexplained timeout, read these version numbers first, then decide whether
to upgrade.

## The Hub line: two version numbers side by side

```
✅ CommHub reachable (… v0.9.0-preview.38; this machine's anet hub start pins 0.9.0-preview.44)
```

The first is the **version the Hub reports**; the second is the version **this CLI's
`anet hub start` pins**. 🔴 **The second half is hidden when they match** — it only appears when
there is a gap.

Here too, no judgement is made about which is right: a Hub older or newer than the pin can both
be perfectly reasonable (you are connected to a Hub someone else operates, the local Hub has not
been restarted, or the pin is deliberately old). It states both numbers and leaves the decision
to you.

⇒ When chasing "this feature behaves wrong against this Hub", read how far apart these two are first.

## The `grok build` line: it is about the **next restart**, not about now

Only nodes whose runtime is `grok-build-cli` / `grok-build-acp` get this row.

The grok CLI **updates itself**. After it does, a **running node is unaffected** — it
uses the process it started with, and the roster still shows `idle`. **Only a restart
picks up the new version on PATH**, and restarting is exactly what an agent-node
upgrade requires (#1615).

This row compares the grok the node **started with** against the grok **now on PATH**:

| What you see | What it means |
| --- | --- |
| `ℹ … (same as when this node started)` | No drift |
| `ℹ … (same build, channel label differs)` | Only a ` [stable]`-style channel label differs — **same build**, not drift |
| `⚠ started with X → PATH now has Y` | **Drift.** The running process is unaffected, but the next restart uses Y; if Y is not on the verified list the node refuses to start |
| `⚠ cannot read the grok version on PATH` | `grok` is not on PATH, or `--version` output is an unknown shape — **this is not "fine"** |
| `⚠ no startup banner in the node log` | The log rotated away, or it never started successfully — **also not "fine"** |

When you do hit drift, the older binary is usually still under `~/.grok/downloads/`:

```bash
GROK_BINARY=~/.grok/downloads/grok-<old-version>-<platform> anet node start <node>
```

🔴 This row does **not** judge whether a version is valid. The verified list lives in
`agent-node`, and the `anet` package does not depend on it — rather than copy a list
that would silently drift, it only reports **changed / unchanged**. "Changed" is enough
to make you careful before restarting.

## What it **cannot** answer

This section matters more than the ones above — the most dangerous way to use a diagnostic is
to ask it something it never judged.

- **Not "is my node alive".** doctor sends no probe to any node. `Sessions: N registered` is a
  roster count with no liveness in it.
  → [Is this node still alive](/en/troubleshooting/is-this-node-alive)
- **Not "is the Hub's data correct".** It only called `/health`.
- **Not "can my runtime actually run".** The version lines only prove the binary exists and can
  report a version.
- **`0 node(s)` is not a fault.** A fresh install has no nodes yet; but if you did have some,
  their config directory is gone. doctor cannot tell these apart, so it states both and does not
  pick one for you.

## The two Feishu x runtime lines (2.3.0-preview.76+)

Every node that has a Feishu channel configured while its runtime is **not**
`claude-agent-sdk` gets one line:

```
↳ <node> feishu
  runtime=<runtime> has a Feishu channel configured, but only claude-agent-sdk
  has been verified; the Feishu tool-refusal layer does not fire on the others (#1259)
```

**It says "this combination has never been verified", not "it is broken".**
Whether to act depends on whether that node's Feishu channel is actually used.

At the end there is an inventory line that is printed **whether or not anything matched**:

```
Feishu x runtime inventory — scanned N node config(s) under <dir>;
this is only **this one .anet tree**, the machine may hold others
```

🔴 **The denominator matters more than the verdict.** A check that only speaks
when something is wrong cannot verify itself; with `N` present, "0 matches" and
"scanned nothing at all" stop looking identical.

🔴 **`0 matches` does not mean the machine is clean.** doctor scans
`<current working directory>/.anet/nodes` — **that tree only**. Nodes started
elsewhere on the same machine are out of reach; run it again from that directory
to cover them.

## `--fix` changes things

`anet doctor --fix` runs compatibility migrations and re-issues node tokens the Hub rejected.
**It modifies configuration** — it is not read-only. Run it without `--fix` first and read the
output before deciding.
