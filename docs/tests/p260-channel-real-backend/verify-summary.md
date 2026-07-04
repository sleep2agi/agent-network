# #260 P5 — channel edit real backend: verify snapshot

Real hub + real agent-node in one container, driving the full
config-apply chain with a `channels` field in the patch. Extends the
existing `tests/qa-rfc024-config-apply/` scaffold rather than starting
a parallel test dir.

## Reproduce

```bash
docker build -f tests/qa-rfc024-config-apply/Dockerfile -t anet-260-p5 .
docker run --rm --tmpfs /tmp:rw,exec anet-260-p5
```

## Result

```
── Result ──
  PASS=20  FAIL=0  SKIP=2
```

The 2 skips are the pre-existing `[W1] hot-patch contract surface` /
`[W1] drain-mid-kill resilience` stubs from qa-rfc024 §7.2 — not
touched by this PR.

## Scenario 11 — 7 assertions all green

```
=== 11. #260 P5 — channels patch wire (hub schema + narrowing + tier) ===
  ✓ 11a hub accepted channels-only patch (update_id=cu_… apply_mode=restart)
  ✓ 11b channels-only patch classified as apply_mode=restart
  ✓ 11c patch_json in node_config_updates carries channels=[telegram,feishu]
  ✓ 11d hostile input accepted for narrowing (update_id=cu_…)
  ✓ 11d hostile input narrowed to 'telegram,feishu'
      (evil/wechat/commhub/42/injection/dup all dropped, case-folded)
  ✓ 11e channels: [] disable-all: apply_mode=restart + patch_json has channels key
  ✓ 11f flags-only patch keeps channels absent + apply_mode=hot (no regression)
```

## The 5 rings 通信IM马's wire-check flagged as broken — now connected

1. **Dashboard `EDITABLE_FLAGS` includes channels** — landed on dashboard
   PR #31 (out of scope here, but referenced by the hub side).
2. **Hub `update_node_config` MCP schema accepts `channels`** —
   `server/src/tools.ts:1578`. Zod is deliberately loose
   (`z.array(z.unknown()).max(16)`) so a stray non-string doesn't
   fail-fast the whole request; the narrowing at the boundary is where
   the type discipline lives.
3. **Hub writes channels into the patch row + classifies as restart-
   tier** — `server/src/config-apply-validate.ts` grows `EDITABLE_
   CHANNELS`, `narrowChannelsPatch`, updated `validatePatch` +
   `computeApplyMode`. Persisted verbatim in `node_config_updates.
   patch_json`.
4. **Agent-node config-apply merges channels into config.json** —
   `agent-node/src/runtime/config-apply.ts` grows the same allow-list,
   validators, and a `mergePatch` that REPLACES `existing.channels`
   wholesale (empty array = disable-all).
5. **Node restart re-forks channel workers from the new config** —
   `cli.ts:521-528` already reads `fileConfig.channels` at boot and
   forks per-type workers (`TELEGRAM_CHANNELS`, `FEISHU_CHANNELS`) —
   no change needed here; the restart-tier dispatch is what makes the
   swap take effect.

## Discovery: `commhub` is transport, not a channel worker

`agent-node/src/cli.ts:673` exits(1) at boot for any channel type
that isn't `telegram` or `feishu`. `commhub` is the RPC transport
every node speaks unconditionally, not a per-node fork target. Both
the hub and node allow-lists here therefore reduce to
`{telegram, feishu}`. Dashboard PR #31 still has `commhub` in its own
whitelist; hub silently drops it via `narrowChannelsPatch`, and the
matching dashboard narrow is filed as follow-up (no user-visible
regression — the toggle just refuses to save `commhub`).

## Zod-loose + narrow-strict rationale

The prior `z.array(z.string())` rejects the entire request the moment
any element isn't a string. The wire contract for hostile input drop
(通信龙 P5 派工) wants junk *silently narrowed*, not the whole request
failing with a 400. So the zod schema mirrors `flags`'s
`z.record(z.unknown())` shape (defensive first layer: max length +
array-ness only), and `narrowChannelsPatch` does the real allow-list
narrowing at the wire boundary. `validatePatch` re-rejects on any
non-string / non-allow-list entry if a future caller bypasses
narrowing — belt and braces.

## Unit test coverage

- `server/src/config-apply-validate.test.ts` — 65 pass, 0 fail
  (+ 22 new for `EDITABLE_CHANNELS`, `narrowChannelsPatch`,
  channels-in-`computeApplyMode`, channels-in-`validatePatch`).
- `agent-node/src/runtime/config-apply.test.ts` — 66 pass, 0 fail
  (+ 16 new: `validateLocalPatch` channel cases, `computeApplyMode`
  restart-tier upgrade, `mergePatch` replace-vs-merge semantics).

## Red-line 3-layer audit

- Broad private-fork keyword regex on diff = 0 hits
- Slug regex on diff + commit msg = 0 hits
- Real vendor key literal regex on diff + evidence = 0 hits
- No `Co-Authored-By` per project policy
