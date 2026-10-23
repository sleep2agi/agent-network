# agent-node — reuse the host-shared OpenCode server, v2.5.0-preview.155

Ships `main` after `.154`. One runtime fix, no new capability.

```
@sleep2agi/agent-node@2.5.0-preview.155
```

## What changed

- **#1676 — the shared-server observation no longer fails on a normal host.**
  `agent-node/src/runtime/opencode-host-shared-observer.ts` refused the whole
  observation (`reason=permission_denied`) as soon as *any* `/proc/<pid>/fd`
  could not be read. On real machines that is guaranteed: root/system daemons are
  other-uid, and same-uid daemons that set `PR_SET_DUMPABLE=0` (user systemd
  units, agents) are unreadable too. Measured on one host: **216 EACCES fd
  tables**, including `pid 1415 uid=1000`.

  Consequence before this release: every daemon-created OpenCode V2 node fell
  back to a **node-private** server, which has no provider credentials — the
  first turn then failed with no provider error (the last段 of #1610).

  The rule is now: unreadable fd tables are counted, not fatal; a refusal is kept
  **only** when no readable holder exists *and* some fd tables were unreadable
  (the #2784 safety property — never guess a pid). Once exactly one readable
  holder is found, its own `/proc` entry still supplies uid / start ticks / argv.

- No behaviour change to argv/generation checks (still diagnostics only), the
  daemon create flow, or any wire format.

## Verification

- Real `/proc` on the affected host, same URLs that used to refuse:
  `127.0.0.1:46663 → ok pid 2659068 uid 1000`, `:42613 → ok pid 2659875`,
  `:42757 → ok pid 2162946`.
- `agent-node/src/runtime/opencode-host-shared-observer.test.ts`: **29 pass / 0 fail**,
  including the new cases (other-uid EACCES, same-uid `dumpable=0` EACCES, and the
  preserved refusal when nothing readable exists).
- PR: `#2945`.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.155
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.155
agent-node --version     # 2.5.0-preview.155
# restart the node process so the new runtime is picked up
```

Existing nodes keep running the old runtime until restarted. The CLI pairing
constant is bumped to `.155` in the **following** CLI release
(`agent-network@2.3.0-preview.192`), so this node version is published first and
the pair is closed immediately after — the same order as `.154`/`.191`.

## Rollback

`npm i -g @sleep2agi/agent-node@2.5.0-preview.154` and restart. No data or config
migration is involved.
