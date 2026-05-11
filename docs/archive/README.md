# Archive — Historical Documents

> ⚠️ **This directory is a graveyard, not a source of truth.**

The files in `docs/archive/` are historical design documents, RFCs, proposals, and earlier iteration plans. They are kept for traceability but **do not reflect the current implementation**.

## What's in here

- Design proposals that were tried and abandoned
- Early CLI / database / channel design notes superseded by later iterations
- E2E test plans from earlier preview lines
- Iteration plans whose milestones are now folded into the live `docs/evolution-log.md`

## Reading these files

- **Don't** quote them as current behavior in issues or PRs.
- **Don't** restore code or APIs from them without first checking against `agent-network/`, `agent-node/`, and `server/` source.
- **Do** use them to understand *why* the current design looks the way it does — many constraints in the live code only make sense in light of these earlier drafts.

## Source of truth

For current state, look at:

- [`README.md`](../../README.md) / [`README.en.md`](../../README.en.md) — user-facing summary
- [`docs-site/docs/`](https://anet.sh) — user docs (v2.1 stable)
- [`SECURITY.md`](../../SECURITY.md) — current threat model + hardening roadmap
- [`docs/open-source-security-risk-report.md`](../open-source-security-risk-report.md) — full security audit
- [`docs/evolution-log.md`](../evolution-log.md) — what's actually shipped, in chronological order
- The npm registry — `npm view @sleep2agi/agent-network version` is the authoritative version number

When in doubt, the code wins.
