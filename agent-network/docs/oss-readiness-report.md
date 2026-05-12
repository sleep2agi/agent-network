# Agent Network OSS Readiness Report（历史 — 已开源）

Date: 2026-05-12
Scope: `agent-network/` package and code paths used by `anet`.

> **⚠️ 状态更新（2026-05-12 晚）**
>
> 本报告 P0/P1 项已在 v0.8.0 / v0.8.1 处理完毕，**项目已于 2026-05-11 正式开源**（Apache 2.0，git tag `v0.8.1`）。本文保留为发布前审计快照。
>
> 仍未关闭的项跟踪在 GitHub Issues 和 [docs/open-source-security-risk-report.md](../../docs/open-source-security-risk-report.md) 顶部 banner（含完整对照表）。

## Summary（历史，仅作发布前审计快照）

OSS readiness: **not ready for public open-source until P0 is resolved**.

The current tree does not contain a hardcoded real MiniMax/GitHub/OpenAI token in `agent-network/`, and no `.env` file is currently present. However, there are open-source blockers around generated secret files, internal identifiers, and shell execution. These should be fixed before making the repository public.

## Scans Run

- Git history secret grep:
  - `git log -p --all -- agent-network server | grep -iE "ghp_|github_pat_|sk-cp-|sk-[a-zA-Z]|api[-_ ]?key|secret|password=|token="`
  - Result: examples/placeholders and token-handling code only; no exact `sk-cp-wuhhYHBYC...` hit.
- `.env` history/current tree:
  - `git log --all --pretty=format: --name-only --diff-filter=A -- agent-network server | grep -E "(^|/)\\.env"`
  - `find agent-network server -name ".env*" ...`
  - Result: no current `.env` files in scope; no added `.env` files found in history query.
- PII/internal grep:
  - Found maintainer username and a real server IP in source/tests (specific values redacted from this report; see findings #1/#2 below for files/lines).
- `npx license-checker --summary`:
  - MIT: 179, ISC: 11, BSD-2-Clause: 9, BSD-3-Clause: 6, Apache-2.0: 5, 0BSD: 1.
- `npm audit --audit-level=moderate --json`:
  - 0 vulnerabilities.
- `npm outdated --json`:
  - Outdated but non-blocking: `@inquirer/prompts`, `@types/node`, `javascript-obfuscator`, `typescript`.

## P0 Risks

1. **CLI writes auth tokens into project `.env` files**
   - `agent-network/bin/cli.ts:802`
   - `agent-network/bin/cli.ts:806`
   - `agent-network/bin/cli.ts:1527`
   - `agent-network/bin/cli.ts:1530`
   - Risk: `anet init project` / Claude Code integration can write `COMMHUB_TOKEN` into project-local `.anet/.env`. Community users may accidentally commit this file, leaking live `utok_`/legacy tokens.
   - Recommendation: stop writing tokens into project `.env`; use node-local `config.json` with `0600`, or user-level `~/.anet/config.json`. Add `.anet/.env` to generated `.gitignore` if legacy compatibility is kept.

2. **Telegram bot token is stored in a project-local `.env`**
   - `agent-network/bin/cli.ts:971`
   - `agent-network/bin/cli.ts:977`
   - Risk: bot tokens are long-lived credentials and the path is inside `.anet/nodes/<node>/channels/telegram/.env`, which can be committed with project state.
   - Recommendation: store channel secrets under `~/.anet/secrets/` or write `.gitignore` for `.anet/**/.env`. Keep `chmod 600`, but do not rely on permissions alone for OSS users.

3. **Shell execution with user-influenced strings**
   - `agent-network/bin/cli.ts:1600`
   - `agent-network/bin/cli.ts:1605`
   - `agent-network/bin/cli.ts:1641`
   - `agent-network/bin/cli.ts:1920`
   - Risk: `spawn(..., { shell: true })` is used for agent runtimes and server startup. Some args include user-controlled node names, runtime values, config paths, or environment-derived paths. Even when arrays are passed, `shell: true` weakens escaping guarantees.
   - Recommendation: replace shell mode with direct executable + arg arrays. For fallback `npx`, use `spawn("npx", ["-y", "@sleep2agi/agent-node@preview", ...agentArgs], { shell: false })`.

## P1 Risks

1. **Internal IP and maintainer-specific comments remain in source**
   - `agent-network/bin/cli.ts` contains a concrete public IP `http://<redacted-ip>:9200` (specific value omitted from this audit; see source file:line) in stale hub migration logic.
   - `agent-network/bin/cli.ts` contains comments referencing the maintainer's first name (specific value omitted from this audit).
   - Risk: not a credential, but it exposes internal operational history and a real host reference.
   - Recommendation: replace the concrete IP with a generic migration sentinel or remove once users have migrated; remove maintainer-specific comments.

2. **Personal path examples remain in source comments**
   - `agent-network/src/node-server.ts:41`
   - Risk: leaks `/home/<user>/...` style local context (specific username appears in source comment).
   - Recommendation: change to a neutral example such as `/home/user/project`.

3. **README is stale and tells users to use `admin / anethub`**
   - `agent-network/README.md:5`
   - `agent-network/README.md:25`
   - `agent-network/README.md:30`
   - `agent-network/README.md:33`
   - `agent-network/README.md:67`
   - Risk: v0.8 bootstrap now uses admin `utok_` and the exact default credential behavior has changed across preview/stable. Stale docs cause failed first-run flows and unsafe copy-paste.
   - Recommendation: sync README to current stable v0.8.1/v0.8.2 behavior and link to `https://anet.sh`.

4. **CLI prints one-time reset token in plaintext**
   - `agent-network/bin/cli.ts:2153`
   - `agent-network/bin/cli.ts:2154`
   - Risk: this is intended one-time admin UX, but terminal logs can be collected by CI/support tooling.
   - Recommendation: keep if intentional, but mark as sensitive, avoid in non-interactive mode unless `--print-token` is explicitly passed, and document rotation.

## P2 Risks

1. **Outdated dependencies**
   - `@inquirer/prompts` latest major 8.x vs current 7.x.
   - `typescript` latest major 6.x vs current 5.x.
   - Recommendation: defer major upgrades until after OSS gate; current `npm audit` is clean.

2. **License metadata is good but no generated NOTICE**
   - `agent-network/LICENSE` is Apache-2.0.
   - `agent-network/package.json` license is Apache-2.0.
   - Recommendation: optional `NOTICE` or dependency license summary in docs for enterprise users.

3. **Current package version is preview while README describes stable**
   - `agent-network/package.json:3`
   - `agent-network/README.md:5`
   - Recommendation: align package, README, and docs-site before OSS launch.

## Recommended Gate Checklist

- Fix P0 secret-file generation before public repo.
- Remove internal IP/person/path references.
- Sync README to the actual v0.8.1/v0.8.2 stable UX.
- Add `.gitignore` coverage for `.anet/`, `.env`, `admin-utok.json`, logs, and node channel secrets in generated projects.
- Add CI secret scan (`gitleaks` or equivalent) over both current tree and history for release branches.
