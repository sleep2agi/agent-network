# `@sleep2agi/agent-network@2.3.0-preview.120`

Since `.119`, `agent-network/` has one change that ships in the tarball, plus the pairing bump:

| Commit | PR | What |
|---|---|---|
| de5c3cd8 | #2172 | `anet` now sends a `client_label` on every password login and register, of the form `anet <version> · <hostname> · <subcommand>`. It is sent from `anet hub start` (default account on first start), `anet register`, `anet login`, `anet demo sci-team` and `anet node create --batch`. The Hub already stored this field; `anet` never sent it, so the app's login-devices list showed these sessions as unnamed. The `hub start` liveness probe is unchanged. Labels are cleaned and cut to 64 characters with the same rules the Hub applies; the hostname is shortened first (at most 24 characters) so the subcommand stays visible |

- `PAIRED_AGENT_NODE_VERSION` now points at `agent-node@2.5.0-preview.93` (#2196: the node reads its own alias with a filtered status request), and `PAIRED_AGENT_NETWORK_VERSION` at `.120`. The agent-network preview must be published on the same day as agent-node, or `published-pins` goes red.
- No token-flow change: `anet login --token` does not touch this code. No `client_id` or session reuse yet.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.120
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.120 @sleep2agi/agent-node@2.5.0-preview.93
```

🔴 **Upgrade both packages together** (`.120 ↔ .93`).

## Evidence

- #2172: `src/login-client-label.test.ts`, 7 tests: label format, missing version or host, long hostname, total length ≤ 64, control characters removed, and a wiring check that finds every `/api/auth/login|register` call in `cli.ts` (pinned at 6: five real calls plus the probe) and requires a label on all but the probe. The same test fails on the pre-change `cli.ts` and lists the five call sites.
- Throwaway Hub with a temporary HOME and DB: after `anet register` and `anet login`, `GET /api/auth/sessions` lists both sessions with labels ending in `register` and `login`.

## promote 时的 must_contain

`"version": "2.3.0-preview.120"`
