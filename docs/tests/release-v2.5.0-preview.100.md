# agent-node 2.5.0-preview.100

Since `.99` (release merge `f026eee1`), `agent-node/` has two changes:

| Commit | PR | What |
|---|---|---|
| 3d77d8dc | #2340 | #517: opencode child-env — a process inside `execve()` is no longer read as "no environment" |
| ac529505 | #2335 | #521: test only — `codex-app-server-bridge.test.ts` covers interrupted steered turns (not in the package; it ships `dist/` only) |

## Behaviour

- **opencode launch trees are no longer deleted while a tool subprocess is mid-`execve()`** (#517 / #2340). The live-reference scan (`launchRootReferencedByLiveProcess`) read `/proc/<pid>/environ` once. Between `exec_mmap` and `create_elf_tables` that file is empty, so a freshly spawned tool descendant looked unrelated and the live, credential-bearing launch tree could be removed (fail-open). Now an empty `environ` is re-read with a bounded backoff (1, 2, 4 … 128 ms, about 255 ms total):
  - exited processes, zombies and kernel threads have nothing to inherit and are released without waiting;
  - a process still mid-exec when the budget runs out counts as **referenced** (fail-closed);
  - a process whose exec finished with a genuinely empty envp (`env -i`, non-empty cmdline) is unrelated, so it cannot pin every root forever.
- The CI flake behind it (`child-env.test.ts` "exact exited-process identity exemption", seen on #2315) is fixed by waiting for the child to print `ready` instead of Bun's `"spawn"` event.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.100
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.133 @sleep2agi/agent-node@2.5.0-preview.100
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.133 ↔ agent-node@2.5.0-preview.100`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.100` first, then agent-network `.133`, both from the same merge commit.

## Evidence

- #2340, in Docker (test725 image, `node` user) under `--cpus=0.5` plus 4 busy loops, `bun test child-env.test.ts` in a loop: before 10/300 failures (3.3%), after 0/300. Mutation (old single `environ` read behind the new seam) turns the new deterministic test red. test725 agent-node unit `2244 pass / 0 fail`; `check-mutation-pins` GREEN.

## promote 时的 must_contain

`"version": "2.5.0-preview.100"`
