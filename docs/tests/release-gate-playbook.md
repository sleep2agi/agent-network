# Hero 4 — Release-Gate Test Playbook (轻量级)

**Owner**: 通信测试马 (lead) · 文档马 (doc maintenance) · SDK马/通信牛/N站马 (family input) · 工程马 (release verdict gate)
**Status**: living doc — additive per P0 catch
**Last update**: 2026-05-16
**Vincent 5315 强调**: 「不要弄的太重」—— total 30 min/run, P3 不做 CI matrix
**Per [`feedback_docker_smoke_real_tty`]** — Docker `--rm` isolation + real-TTY pexpect drive

---

## 1. Trigger 分级 (when to run)

| When | Cases | ETA |
|------|-------|-----|
| **Every preview ship** (SDK马 / 通信牛 / N站马 push npm @preview) | A + B (5 case) | ~5min |
| **Latest promote** (4 包 dist-tag @latest 翻牌) | A-F all (15 case) | ~30min |
| **Hotfix targeting specific issue** | only the affected family | ~3-8min |
| **Cross-vendor regression** (new vendor onboard or vendor SDK update) | C family × N vendor | ~10min |

---

## 2. 15-case matrix (A-F families)

### A — wizard interactive (Family A — `anet node create` UI/UX)

| ID | Case | Trigger | History P0 ref |
|----|------|---------|----------------|
| **A1** | non-interactive expect baseline (claude-code-cli runtime, no-op wizard) | every preview | [#135 clean exit](https://github.com/sleep2agi/agent-network/issues/135) |
| **A2** | pexpect real-TTY `anet node create` (claude-agent-sdk, full wizard: name→runtime→vendor→model→key→telegram) | every preview | [#137 wizard pexpect](https://github.com/sleep2agi/agent-network/issues/137) |
| **A3** | non-TTY pipe fallback (Option B try/catch — `echo ... \| anet node create`) | latest promote | [#135 Option B](https://github.com/sleep2agi/agent-network/issues/135) |

### B — node lifecycle (Family B — `anet node start/stop/delete/ls`)

| ID | Case | Trigger | History P0 ref |
|----|------|---------|----------------|
| **B1** | mock-claude + `anet node start` parent liveness probe (t=0.5/1.5/2.5s) + exit 0 + 0 `setRawMode errno 5` | every preview | [#138 launchAgent race](https://github.com/sleep2agi/agent-network/issues/138) |
| **B2** | `anet node create` → `anet node ls` chain (await-race regression test) | every preview | [#139 anet ls empty](https://github.com/sleep2agi/agent-network/issues/139) |
| **B3** | `anet node stop <alias>` → hub sees offline within 30s + no orphan agent-node process | latest promote | — |
| **B4** | `anet node delete <alias>` → local config 删 + commhub session row 清 | latest promote | — |

### C — cross-vendor MCP tool emission (Family C — `claude-agent-sdk` / `codex` end-to-end)

| ID | Case | Trigger | History P0 ref |
|----|------|---------|----------------|
| **C1** | claude-agent-sdk + intern-s2-preview → `mcp__commhub__send_task` → receiver inbox `from_session=sender` | every preview | [#101 toolset preset](https://github.com/sleep2agi/agent-network/issues/101), [#102 in-process McpServer](https://github.com/sleep2agi/agent-network/issues/102), [#130 intern bias](https://github.com/sleep2agi/agent-network/issues/130) |
| **C2** | claude-agent-sdk + MiniMax-CN → same MCP send_task chain | latest promote | [#130 minimax no-regression](https://github.com/sleep2agi/agent-network/issues/130) |
| **C3** | codex-sdk runtime config创建 + `ANET_CODEX_STDIO_DIRECT=1` opt-in source markers (`CodexStdioClient` + `processWithCodexStdio` in dist) | every preview | [#141 codex-direct-stdio](https://github.com/sleep2agi/agent-network/issues/141) |

### D — `--tmux` opt-in (Family D — `anet node start` flags)

| ID | Case | Trigger | History P0 ref |
|----|------|---------|----------------|
| **D1** | `anet node start` default foreground (no --tmux flag) → agent-node alive + 0 `setRawMode` warning | every preview | [#136 --tmux opt-in](https://github.com/sleep2agi/agent-network/issues/136) |
| **D2** | `anet node start --tmux` opt-in → tmux session spawn attempted (Docker headless `open terminal failed` is acceptable; flag is recognized) | latest promote | [#136](https://github.com/sleep2agi/agent-network/issues/136) |
| **D3** | `anet --help` flag matrix: `--tmux` present + 0 `--foreground/--no-tmux/--attach` (撤回 verify) | every preview | [#122/#136 撤回](https://github.com/sleep2agi/agent-network/issues/136) |

### E — commhub-server endpoints (Family E — REST API + auth)

| ID | Case | Trigger | History P0 ref |
|----|------|---------|----------------|
| **E1** | `/api/auth/register` 第一用户 = auto-admin + utok + default network 创建 | every preview | [#79 auth bootstrap](https://github.com/sleep2agi/agent-network/issues/79) |
| **E2** | `/api/servers` + `/api/agents/<alias>` (Hero 1+2 endpoints) — 200 + body shape valid | every preview | [#119 servers](https://github.com/sleep2agi/agent-network/issues/119), [#140 health/agents](https://github.com/sleep2agi/agent-network/issues/140) |

### F — macOS-only (Family F — host-OS-specific paths)

| ID | Case | Trigger | History P0 ref |
|----|------|---------|----------------|
| **F1** | macOS `anet node start` real-terminal `--tmux` opt-in (Vincent 本机 verify, Docker Linux unable) | latest promote | [#136 macOS setRawMode](https://github.com/sleep2agi/agent-network/issues/136) |
| **F2** | macOS Safari `dm.vansin.top:3000/login` page load (Next.js chunk 500 regression) | latest promote | dm.vansin.top P0 (own session record) |

**F family caveat**: Docker Linux 跑不了，需要 Vincent macOS 辅助 verify。在 release verdict 标注 "F family pending Vincent macOS sign-off"，不阻塞 Linux-side promote。

---

## 3. Common Docker setup (reuse across cases)

### Base image (slim, NOT alpine — per preview.0 alpine-glibc catch)

```dockerfile
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash python3 python3-pexpect tmux expect curl jq sqlite3 procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun
RUN npm install -g \
      @sleep2agi/agent-node@<VERSION_UNDER_TEST> \
      @sleep2agi/agent-network@preview \
      @sleep2agi/commhub-server@<HUB_VERSION_UNDER_TEST> \
      --force
```

**Why slim not alpine**: `@anthropic-ai/claude-agent-sdk-linux-x64` (claude-agent-sdk runtime spawned binary) is glibc-only. Alpine = musl → C family fails with "claude binary not found". Use slim OR `alpine + apk add gcompat libc6-compat`.

### Env key passthrough (don't leak via host ps)

```bash
ENV_FILE=$(mktemp); chmod 600 "$ENV_FILE"
echo "INTERN_API_KEY=$INTERN_KEY" > "$ENV_FILE"
docker run --rm -t --env-file "$ENV_FILE" --name "smoke-$RUN" anet-img
rm -f "$ENV_FILE"   # never leave key file on disk
```

### Real-TTY pexpect drive (Family A wizard, B mock-claude)

```python
import pexpect, sys
p = pexpect.spawn("anet node create", timeout=30, encoding="utf-8")
p.logfile_read = sys.stdout
p.expect(r"Node name"); p.sendline("test_x")
p.expect(r"选择 runtime"); p.sendline("")  # default
# ... etc
```

### Mechanical 凭证 (DB / log / regex)

- `inbox.from_session = sender_alias` (≠ `api` REST 兜底 ≠ `hub` no-callerAlias)
- `commhub.log` grep `<sender> → send_task → <receiver>: <NONCE>`
- pexpect `logfile_read` 抓 banner / warning / stack-trace
- file existence `.anet/nodes/<alias>/config.json`

---

## 4. Per-case spec (excerpt format)

```markdown
### C1 — claude-agent-sdk + intern → MCP send_task

**Trigger**: every preview ship
**Time**: ~3min
**Setup**: slim + INTERN_API_KEY env

**Run**:
1. `commhub-server &` + register admin → utok
2. `anet node create sender --runtime claude-agent-sdk --model intern-s2-preview --env ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn --env ANTHROPIC_AUTH_TOKEN=$INTERN_API_KEY`
3. Same for receiver
4. `nohup anet node start receiver &` + `nohup anet node start sender &`
5. Wait online (`/api/status` shows both)
6. Dispatch task via REST `/api/task` with nonce: `"请给 receiver 派任务 NONCE-X — please ack"`
7. Poll `inbox` table for row with `session_name='receiver' AND content LIKE '%NONCE-X%'`

**PASS criteria** (all):
- ✅ Row exists
- ✅ `from_session = 'sender'` (mechanical MCP proof, NOT `api` REST fallback)
- ✅ sender startup log contains `[tool] mcp__commhub__send_task({"alias":"receiver",...})`
- ✅ commhub.log contains `<sender> → send_task → receiver: NONCE-X`

**FAIL surface**:
- `from_session = 'api'` → agent fell back to `curl` instead of MCP tool
- No row → agent timeout / refusal / silent failure (check [#129 fast-fail](https://github.com/sleep2agi/agent-network/issues/129))
- Sender log shows "通信工具不可用" → #102 regression
```

---

## 5. Per-preview workflow

1. SDK马/通信牛/N站马 push commit + `npm publish @preview`
2. **PRE-build curl HEAD verify**: `curl -sI .../<pkg>-<ver>.tgz` returns 200 (catch dist-tag-flip-but-tarball-404 per [v0.9.0 Round 5](https://github.com/sleep2agi/agent-network/issues/126#issuecomment-4458336023))
3. Run A1+A2+B1+B2+C1 = preview ship gate (~5min)
4. Paste verdict into release PR / issue comment (table with case + verdict + evidence)
5. If 5/5 PASS → promote candidate
6. Pre-promote: run full A-F (15 case, ~30min)
7. Post-promote: `latest install smoke` (npm @latest fresh container + Case B2 chain-test)

---

## 6. Anti-patterns (lessons from v0.9.0 → v0.10.9 cycles)

1. **bash backticks in echo strings** ([R9 preview.6 catch](report-test-v092-preview6.md)) → cmd substitution spawns interactive wizard → container hang. Use `'` single quotes or escape `\`...\``.
2. **`wait` without specific PIDs** ([R7 preview.5 catch](report-test-v092-preview5.md)) → blocks on long-running agent-node bg processes. Track curl PIDs: `wait "${CURL_PIDS[@]}"`.
3. **`kill -0 $!` on nohup intermediate** → nohup wrapper exits, child stays alive. Use commhub `/api/status` to probe liveness.
4. **`docker run -e KEY=val`** ([v0.9.0 R5 catch](https://github.com/sleep2agi/agent-network/issues/132)) → keys visible in host `ps aux`. Use `--env-file mode 600`.
5. **Trust dist-tag without tarball curl** ([v0.9.0 R5 catch](https://github.com/sleep2agi/agent-network/issues/132)) → `npm view ... dist-tags.latest` may be ahead of actual tarball upload. Always `curl -sI .../-/<pkg>-<ver>.tgz` first.
6. **Trust pane visual over commhub** (preview.4 catch per 通信龙 self-correction in [feedback_pane_vs_commhub_truth](../../memory)) → pane snapshot can lag commhub HIGH messages. Commhub `mcp__commhub__get_all_status` is truth.
7. **Use alpine for claude-agent-sdk tests** ([v0.10.0 preview.0 catch](https://github.com/sleep2agi/agent-network/issues/141)) → alpine musl-libc + glibc-only claude binary = "claude binary not found". Use slim OR `alpine + apk add gcompat libc6-compat`.
8. **One-shot `docker run` 缺 USER node** ([v0.10.0 preview.1 R12 catch](https://github.com/sleep2agi/agent-network/issues/140#issuecomment-4466735967)) → default root user → `claude 错误: 当前以 root 用户运行,Claude Code 拒绝 --dangerously-skip-permissions` → agent-node fast-fails before MCP call. R9/R8/R7/R10 used Dockerfile `USER node` and worked; one-shot `docker run sh -c '...'` pattern dropped it. Fix: `docker run --user node ...` OR bake `USER node` into a pre-built test image. Family C cases ALL require non-root user.
9. **runuser heredoc 默认 cwd = `/`** ([v0.10.0 R13 catch](https://github.com/sleep2agi/agent-network/issues/140#issuecomment-4466836503)) → `anet node create test-x` writes to `/.anet/nodes/test-x/`; `anet node ls` is cwd-relative and looks at `.anet/nodes/` from `/`, so node "appears missing" (B2 chain FAIL surface). **Fix**: runuser heredoc 必显式 `cd /home/node` (或 `cd ~`). agent-network 2.2.0 起 `anet create` + `anet ls` 都依赖 cwd-relative storage layout.
10. **server endpoint test 前需先 `anet node start`** ([v0.10.1 R14 catch](https://github.com/sleep2agi/agent-network/issues/140#issuecomment-4468267128)) → `/api/server/<host>/health` returns `{"ok":false,"error":"server not found"}` (HTTP 404) when no telemetry has registered — the endpoint exists (returns JSON error not generic banner), but reads as FAIL surface. **Fix**: before probing `/api/server/<host>/*`, spin up a node (`anet node start <alias>`) to register host telemetry; only then does the endpoint return 200 + cpu_load_1min/agents schema. Mechanical proof of endpoint existing: JSON error body vs banner-text fall-through.
11. **dashboard binds to hostname not 0.0.0.0** ([v0.10.1 R14 catch](https://github.com/sleep2agi/agent-network/issues/140#issuecomment-4468267128)) → default Next.js dashboard binds to `$HOSTNAME:3030`, which inside Docker is the container ID (e.g. `66c62edb7fb3:3030`) and `curl http://127.0.0.1:3030` returns connection refused (HTTP 000). **Fix**: `HOSTNAME=0.0.0.0 PORT=3030 agent-network-dashboard` to bind all interfaces, then `curl http://127.0.0.1:3030` works.
12. **agent-network 2.2.2+ config.json needs `user_id` + `username` + `token`** ([v0.10.3 R15 catch](https://github.com/sleep2agi/agent-network/issues/149#issuecomment-4469322258)) → R13/R14 SOP wrote `~/.anet/config.json` with only `{hub, token, network_id, network_name}` and `anet node create` accepted it; v2.2.2+ now checks for `user_id` / `username` and rejects with "Not logged in". **Fix**: manual config.json must include `user_id` + `username` (mirror what `anet register` would write), OR pipe stdin to interactive `anet register` (`printf "user\npass\n" | anet register`).
13. **claude-agent-sdk runtime needs a non-root container (`USER node`)** ([#146 gate catch](https://github.com/sleep2agi/agent-network/issues/146#issuecomment-4505347972)) → the `claude-agent-sdk` runtime shells out to the `claude` CLI, which **refuses `--dangerously-skip-permissions` when running as root** (`claude 错误: 当前以 root 用户运行`). In a default `node:24-slim` container (root), every task silently fails with `processTask returned: "claude 错误..."` — the node still registers and shows `idle`, so the breakage is invisible until you check why no task completes / no session writeback happens. **Fix**: `USER node` in the Dockerfile after the root-only `npm install -g` steps; run commhub/anet/agent-node all as the non-root `node` user (`WORKDIR /home/node`). Same root cause family as #8.
14. **tmux server freezes its environment at first-use** ([#146 gate catch](https://github.com/sleep2agi/agent-network/issues/146#issuecomment-4505347972)) → the tmux server captures its environment the first time any `tmux new-session` runs; every later session inherits **that frozen env**, not the caller's current env. `anet node rename` restarts a running node via a tmux session, and #125 envRef gives each node a unique `ANTHROPIC_AUTH_TOKEN_N_<hash>` var — so a per-node var exported *after* the first rename is invisible to later restarts, which FATAL on the missing var (the renamed node never re-registers). **Fix**: create **all** nodes (and export every `ANTHROPIC_AUTH_TOKEN_N_*` var) in a Phase 0, before the first rename starts the tmux server.
15. **#125 envRef: `--env` secrets migrate to a ref-var that must be exported before `anet node start`** ([#146 gate catch](https://github.com/sleep2agi/agent-network/issues/146#issuecomment-4505347972)) → `anet node create --env ANTHROPIC_AUTH_TOKEN=sk-...` does not store the secret in `config.json`; it stores `{"_envRef": "ANTHROPIC_AUTH_TOKEN_N_<hash>"}` and prints `export ANTHROPIC_AUTH_TOKEN_N_<hash>='sk-...'` in the create output. `anet node start` then FATALs (`references env var "..." but it is not set in this shell`) unless that ref-var is exported. The `<hash>` is unique per create invocation. **Fix**: after each `anet node create`, parse the ref-var name from the create log (`grep -oE 'ANTHROPIC_AUTH_TOKEN_N_[A-Za-z0-9]+'`) and `export` it with the secret value before `anet node start`.

---

## 7. Family ownership

| Family | Primary owner | Secondary | Tests live in |
|--------|---------------|-----------|---------------|
| A wizard UI/UX | SDK马 | 通信测试马 | `docs/tests/case-A*` |
| B node lifecycle | SDK马 | 通信测试马 | `docs/tests/case-B*` |
| C cross-vendor MCP | SDK马 | 通信测试马 | `docs/tests/case-C*` |
| D --tmux opt-in | 工程马 | 通信测试马 | `docs/tests/case-D*` |
| E commhub REST | 通信牛 | 通信测试马 | `docs/tests/case-E*` |
| F macOS host paths | Vincent (manual) | 通信测试马 (Docker Linux baseline only) | `docs/tests/case-F*` |

---

## 8. Reference rounds (where this playbook was forged)

| Round | Preview | Issue closed | Key catch |
|-------|---------|--------------|-----------|
| R5 v0.9.0 final | latest | promote chain | dist-tag-flip-but-tarball-404 |
| R7 v0.9.2 preview.5 | 2.1.15-preview.5 | [#137](https://github.com/sleep2agi/agent-network/issues/137) | Option B `inquirer.input()` + non-TTY fallback |
| R8 v0.9.2 preview.6 | 2.1.15-preview.6 | [#138](https://github.com/sleep2agi/agent-network/issues/138) | launchAgent process.exit race |
| R9 v0.9.2 preview.7 | 2.1.15-preview.7 | [#139](https://github.com/sleep2agi/agent-network/issues/139) | anet ls await race (chain-test) |
| R10 v0.9.2 latest | promote | release v0.9.2 | latest install smoke + chain-test 复用 |
| R11 v0.10.0 preview.0 | 2.3.11-preview.0 | [#141](https://github.com/sleep2agi/agent-network/issues/141) Phase 1 | alpine/glibc env limit caught |
| R12 v0.10.0 preview.1 | (in flight) | [#141 + #140](https://github.com/sleep2agi/agent-network/issues/140) | TBD — first A-F run |

---

**Author-Agent**: 通信测试马
**Reviewer**: 通信龙
**Refs**: [v010 chain-test baseline](v010-chain-test-baseline.md), [Round 9 preview.7 6/6 PASS](report-test-v092-preview7.md)

---

## 9. Evidence Provenance Gate (常设规则, 07-29 P3-A 事故固化)

**Scope (MUST apply to)**: Docker E2E, preview smoke, 安全 gate (RFC-030 P3 identity/security), release promote (preview → latest).
**Enforcement**: **没有本节要求的 provenance manifest, 不得 GO preview/latest**。作者自报 (author-generated report, tests committed in candidate tree) 不构成独立证据 (per [[feedback_gate_evidence_must_be_runner_generated]]).

### 9.1 Runner requirements (MUST)

R-1 Runner **MUST** execute from a **clean checkout at the exact candidate SHA**. `git worktree add` from a fresh `origin/main` fetch, or `git clone --depth 1 <repo> <tmpdir> && git checkout <SHA>`. Runner tree **MUST NOT** live inside the candidate PR tree.

R-2 Provenance manifest **MUST** record (verbatim commands, not derived):
- `git rev-parse HEAD` — exact 40-hex SHA (**MUST** equal candidate)
- `git rev-parse HEAD^{tree}` — root tree oid
- `git status --porcelain` — **MUST** be empty (any output → INVALID)
- `git log -1 --format=%H` — for cross-verify
- Runner script SHA256 (`sha256sum <runner>.sh`)
- npm tarball SHA256 for every `<pkg>@<version>` under test (`sha256sum <pkg>-<version>.tgz` from `npm pack`)
- Runner package.json SHA256 (if the runner has a manifest)
- Start / end timestamp (RFC3339, `Asia/Shanghai`)
- Runner environment: `uname -a`, `node --version`, `npm --version`, `docker --version`, `bash --version` (first line each)
- `NODE_ENV`, `CI`, `ANET_*` flags actually present at runtime (name only, value only when NOT a secret — see 9.6)

R-3 If **any** of the above is missing, contradictory, or unreproducible → the entire evidence bundle **is INVALID**. Partial acceptance is prohibited (do not "trust the rest").

### 9.2 Test switches / fault-injection flags (MUST)

R-4 Every test switch, feature flag, or fault-injection env referenced in the runner **MUST** exist in the candidate SHA. Manifest **MUST** include, per flag:
- The exact file path (candidate-relative) where the flag is read
- A `git show <SHA>:<path> | grep -n <FLAG>` transcript proving the read site
- The default value at that SHA

R-5 If a flag referenced in the runner is **not found** in the candidate SHA (typo, invented, from a not-yet-merged branch, or from a stale local checkout), the evidence bundle is **INVALID**. See **9.5 INVALID example** for a concrete case (`ANET_P3_IDENTITY_DISABLE`).

### 9.3 Runner isolation & evidence-only PR (MUST)

R-6 Runner-generated evidence **MUST** be produced in a directory **outside the candidate tree** (e.g. `/tmp/anet-gate-<runid>/evidence/`), then attached to a **separate evidence-only PR** or issue comment. Files inside the candidate PR tree (including `docs/tests/report-*.md` committed together with the candidate code) do **not** count as independent evidence.

R-7 The evidence-only PR **MUST NOT** mix runtime code, config, or test-source changes. If the runner requires new fixtures, land those under a separate, prior PR; the evidence PR is diff-free from the candidate.

### 9.4 Reviewer duties (MUST)

R-8 The reviewer **MUST** perform an **independent clean checkout** at the candidate SHA and **re-run the key unit tests** listed in the manifest. Screen-reading the runner log is insufficient.

R-9 The reviewer **MUST** actively falsify at least **two** critical gates via mutation:
- Temporarily flip an assert (e.g. change `expect(x).toBe(true)` to `.toBe(false)`) and confirm the gate **turns red**.
- Comment out a test body and confirm coverage/gate output changes.
- Any gate that "exists but never fails" (green under any input) **counts as no gate**.

R-10 Mutation results (before/after) **MUST** be recorded as part of the reviewer's independent evidence and attached to the review verdict.

### 9.5 INVALID example (07-29 P3-A)

- Candidate SHA: `9f2ec282...`
- Report claimed the identity gate was exercised via `ANET_P3_IDENTITY_DISABLE=1`.
- `git show 9f2ec282:agent-network/src/**/*.ts | grep ANET_P3_IDENTITY_DISABLE` → **0 hits** across the candidate tree.
- The flag existed in the runner author's local branch but **was never committed**; the gate silently no-oped.
- Verdict: entire evidence bundle **INVALID**. Rollback = discard old evidence, cut a new candidate SHA (with the flag actually present), re-run under a new evidence-only PR. No PASS from the old bundle carries over.

### 9.6 Recovery flow (INVALID → new evidence)

1. Mark the old evidence bundle **INVALID** in the tracking issue (comment, do not delete).
2. Land the missing fixture/flag as a separate PR; wait for merge.
3. Cut a new candidate SHA that contains the fixture.
4. Fresh runner + fresh reviewer follow §9.1–9.4 from scratch. No inheritance from prior PASS lines.
5. Only after the new bundle passes independent review may the gate transition to GO.

### 9.7 Secret hygiene (MUST)

R-11 Manifest and runner logs **MUST NOT** record: any token (utok_/ntok_/atok_/sk-*/Bearer/JWT/gh[p|o|u]_/vercel_*/etc.), credential material, private key content, `~/.claude`/`~/.commhub`/`~/.anet` path values, or environment-variable **values** for anything that could plausibly be sensitive.

R-12 Allowed in manifest: SHA256 hashes of tarballs / scripts / non-secret artifacts, tool versions (node/npm/docker/etc.), env-var **names** (not values), boolean feature-flag settings, RFC3339 timestamps, hostnames when non-sensitive.

R-13 Do **not** fingerprint long-term secrets (e.g. `sha256sum` of an OAuth token or long-lived API key). Short-lived per-run nonces are OK.

### 9.8 Applicable pipelines & GO gate

| Pipeline | Provenance manifest required? | Consequence if missing |
|---|---|---|
| Docker E2E (families A–F, this playbook §2) | **MUST** | No preview ship |
| Preview smoke (§5 per-preview workflow) | **MUST** | No preview ship |
| Security gate (RFC-030 P3, identity/permission) | **MUST** | No merge to main |
| Release promote (preview → latest, §5 step 6–7) | **MUST** | No dist-tag flip |

**No provenance manifest → no GO.** Applies uniformly; the standard is not case-by-case.

### 9.9 Manifest template (copy-paste)

```yaml
# evidence-manifest.yaml — v1
runner:
  script_path: /tmp/anet-gate-<runid>/run.sh
  script_sha256: <64-hex>
  invoked_at: 2026-07-29T10:00:00+08:00
  finished_at: 2026-07-29T10:07:34+08:00
  host_env:
    uname: "Linux ... x86_64"
    node: "v24.1.0"
    npm: "10.7.0"
    docker: "27.1.1"
    bash: "GNU bash, version 5.2.15..."

candidate:
  repo: sleep2agi/agent-network
  sha: <40-hex>                       # MUST equal target
  tree_oid: <40-hex>                  # git rev-parse HEAD^{tree}
  status_porcelain: ""                # MUST be empty string
  checkout_path: /tmp/anet-gate-<runid>/checkout

packages_under_test:
  - name: "@sleep2agi/agent-network"
    version: 2.5.0-preview.7
    tarball_sha256: <64-hex>
  - name: "@sleep2agi/agent-node"
    version: 2.5.0-preview.7
    tarball_sha256: <64-hex>

flags:
  - name: ANET_P3_IDENTITY_DISABLE
    read_at: agent-network/src/security/identity.ts:42       # candidate-relative
    grep_transcript: |
      $ git show <SHA>:agent-network/src/security/identity.ts | grep -n ANET_P3_IDENTITY_DISABLE
      42:  if (process.env.ANET_P3_IDENTITY_DISABLE === "1") return null;
    default_value: unset

cases:
  - id: P3-A
    verdict: PASS|FAIL|INVALID
    stdout_sha256: <64-hex>
    stderr_sha256: <64-hex>
    artifacts_dir: /tmp/anet-gate-<runid>/evidence/P3-A/

secret_hygiene:
  scan_command: "grep -R -E '(ntok|utok|atok)_|sk-[A-Za-z0-9]{20,}|Bearer |eyJ' /tmp/anet-gate-<runid>/evidence/"
  scan_exit_code: 1                    # 1 = no match; MUST be 1

reviewer:
  independent_checkout_path: /tmp/anet-gate-<runid>-review/checkout
  independent_checkout_sha: <40-hex>   # MUST equal candidate.sha
  mutations_attempted:
    - target: agent-network/test/security/identity.test.ts:88
      before_verdict: PASS
      after_verdict: FAIL
    - target: agent-network/test/security/identity.test.ts:112
      before_verdict: PASS
      after_verdict: FAIL

verdict:
  overall: PASS|FAIL|INVALID
  reason: "..."
```

### 9.10 Review checklist

- [ ] Runner ran from a clean checkout **outside** the candidate PR tree
- [ ] `git status --porcelain` transcript captured and empty
- [ ] `git rev-parse HEAD` equals candidate SHA
- [ ] Every flag / switch in the runner has a `git show <SHA>:<path> | grep` proof of presence
- [ ] Evidence lives in an evidence-only PR / attachment, not mixed with candidate code
- [ ] Reviewer re-ran key unit tests from an **independent** checkout at the same SHA
- [ ] Reviewer performed ≥ 2 gate mutations and confirmed each turns red
- [ ] Secret-hygiene scan attached, exit code = 1 (no match)
- [ ] Manifest fields all present per §9.9 template
- [ ] Applicable pipeline row in §9.8 satisfied

> **Cross-reference**: [`../sop/methodology.md`](../sop/methodology.md) §3 Verify-First SOP records how these gates plug into the general release verify chain. This §9 is the authoritative source for the provenance manifest itself; do not fork the template.
