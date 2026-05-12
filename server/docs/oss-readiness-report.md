# CommHub Server OSS Readiness Report（历史 — 已开源）

Date: 2026-05-12
Scope: `server/` package and `@sleep2agi/commhub-server`.

> **⚠️ 状态更新（2026-05-12 晚）**
>
> 本报告 P0/P1 项已在 v0.8.0 / v0.8.1 处理完毕，**项目已于 2026-05-11 正式开源**（Apache 2.0，commhub-server@0.8.0 git tag `v0.8.1`）。本文保留为发布前审计快照。
>
> 仍未关闭的项跟踪在 GitHub Issues 和 [`docs/open-source-security-risk-report.md`](../../docs/open-source-security-risk-report.md) 顶部 banner。

## Summary（历史，仅作发布前审计快照）

OSS readiness: **not ready for public open-source until P0/P1 items are resolved**.

The current `server/` tree does not contain a real hardcoded MiniMax/GitHub/OpenAI token, and the default bind/auth posture is mostly safe in v0.8 (`127.0.0.1`, user-token flow, tmux disabled). The main blockers are stale direct-run docs, a private CORS origin, lack of an auditable lockfile, and remaining legacy master-token paths that must be clearly documented or removed in v1.0.

## Scans Run

- Git history secret grep:
  - `git log -p --all -- agent-network server | grep -iE "ghp_|github_pat_|sk-cp-|sk-[a-zA-Z]|api[-_ ]?key|secret|password=|token="`
  - Result: placeholders/examples and token-handling code only; no exact `sk-cp-wuhhYHBYC...` hit.
- `.env` history/current tree:
  - No current `.env` files found in `server/`.
- PII/internal grep:
  - Found maintainer's private domain hardcoded in CORS allowlist (specific value redacted; see finding #1 for file:line).
- `npx license-checker --summary`:
  - MIT: 84, ISC: 7, BSD-3-Clause: 2, Apache-2.0: 1, BSD-2-Clause: 1.
- `npm audit --audit-level=moderate --json`:
  - Failed with `ENOLOCK`; `server/` has no package-lock/shrinkwrap.
- `npm outdated --json`:
  - `{}`.

## P0 Risks

1. **Direct server README suggests insecure/legacy startup paths**
   - `server/README.md:18`
   - `server/README.md:21`
   - `server/README.md:22`
   - Risk: `--dev-open` and legacy master-token examples are too prominent for a public OSS first-run path. Users may deploy unauthenticated or anchor on deprecated auth.
   - Recommendation: make `anet hub start` the only primary quickstart. Move `--dev-open` to a clearly labeled local-development-only section. Move `--token`/`COMMHUB_AUTH_TOKEN` to deprecation notes.

2. **README still documents `admin / anethub` default credential**
   - `server/README.md:15`
   - Risk: if the published flow auto-generates/stores admin `utok_` or has changed bootstrap behavior, this is either wrong or trains unsafe expectations.
   - Recommendation: update to current v0.8.1/v0.8.2 stable behavior and explicitly state where bootstrap credentials/token are stored.

## P1 Risks

1. **Private/personal CORS origin is hardcoded**
   - `server/src/index.ts:249`
   - `server/src/index.ts:250`
   - Risk: exposes a maintainer-specific private domain and bakes a private deployment into OSS server defaults.
   - Recommendation: remove the hardcoded private origin; require `COMMHUB_CORS_ORIGINS` for non-local dashboards. Keep public production domain only if it is the official service domain.

2. **No lockfile means `npm audit` cannot run reproducibly**
   - `server/package.json`
   - Risk: OSS consumers cannot verify the exact dependency tree; CI security checks will fail with `ENOLOCK`.
   - Recommendation: add `package-lock.json` or migrate server package to a checked-in Bun lock with a documented audit process. For npm packages, `package-lock.json` is the pragmatic choice.

3. **Legacy master-token compatibility remains in code**
   - `server/src/index.ts:11`
   - `server/src/index.ts:23`
   - `server/src/index.ts:107`
   - Risk: v0.8 compatibility is intentional, but OSS users may misunderstand `COMMHUB_AUTH_TOKEN` as the main auth model.
   - Recommendation: keep only as explicitly deprecated compatibility until v1.0. Add a v1.0 removal checklist and tests that prove master-token cannot write.

4. **tmux surfaces intentionally expose terminal I/O when enabled**
   - `server/src/index.ts:882`
   - `server/src/index.ts:906`
   - `server/src/index.ts:1110`
   - Risk: guarded by `COMMHUB_ENABLE_TMUX=1`, admin auth, and localhost/allowlist, but the feature is high-impact if misconfigured.
   - Recommendation: keep disabled by default; document it as dangerous; require explicit allowlist for non-local access. Consider a second env gate for write/send-keys.

## P2 Risks

1. **Version/docs drift**
   - `server/package.json:3`
   - `server/README.md:5`
   - `server/README.md:38`
   - Risk: package says `0.8.0`, README references agent-network `2.1.5`, while current repo has later preview/stable movement.
   - Recommendation: sync README, package metadata, and docs-site before OSS launch.

2. **Password hashing is still SHA-256 + fixed salt**
   - `server/src/db.ts` `hashPassword()`
   - Risk: acceptable only as a known technical debt if DB compromise is out of scope; weak for OSS security posture.
   - Recommendation: schedule bcrypt/Bun.password migration with login-time rehash and legacy verifier.

3. **CORS default only covers localhost dashboard ports**
   - `server/src/index.ts:243`
   - `server/src/index.ts:245`
   - Risk: safe default, but production users need clear docs for `COMMHUB_CORS_ORIGINS`.
   - Recommendation: document production CORS setup and fail closed when origin is unknown, as current code does.

4. **SQL injection posture is mostly good**
   - Most database calls use placeholders.
   - Dynamic `IN` placeholders are constructed from counted arrays in `server/src/index.ts` and `server/src/tools.ts`.
   - Recommendation: keep this pattern; add a lint/test pass for raw string interpolation in SQL before OSS launch.

## Recommended Gate Checklist

- Rewrite `server/README.md` direct-run auth guidance before public release.
- Remove private CORS origin.
- Add a lockfile or documented dependency audit path.
- Keep tmux disabled by default and document its risk.
- Track bcrypt migration as a public security roadmap item.
