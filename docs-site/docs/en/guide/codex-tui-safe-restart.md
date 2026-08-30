# Codex TUI Node Safe Restart Runbook

This runbook applies to any anet node that uses the `codex-app-server` / Codex TUI co-presence topology. The goal is not "the processes exist again"; the goal is to prove that the same node identity, same Codex thread, same working directory, and same primary rollout were restored.

::: danger Stop condition
If identity, directory, thread, rollout, goal state, or online status does not match, stop immediately. Fix the mismatch, then rerun the full acceptance checklist instead of checking only the failed item.
:::

## Acceptance Criteria

A restart is successful only when all of the following are true:

- The target node identity works, and Hub `from_name` / `from_node_id` match the expected node.
- Codex TUI resumes the full original thread ID, not a short-prefix match or the most recent session.
- The primary rollout file did not shrink or get replaced, and its content still belongs to the original thread.
- app-server, TUI, and bridge all use the target node working directory.
- CommHub `project_dir`, Codex TUI `-C`, and the node profile working directory all match.
- The original goal state is preserved: active goals continue after restart; paused goals remain paused.
- app-server, TUI, and bridge are all online, and the Hub reports the target node online or idle.

Seeing processes in a process list is not enough.

## 1. Freeze State Before Restart

Record one table per alias. Do not mix multiple nodes in one checklist:

| Item | Required record |
|---|---|
| Node identity | alias, node_id, isolated `CODEX_HOME` |
| Working directory | absolute path of the expected project directory |
| Codex thread | full 36-character session / thread ID |
| Primary rollout | absolute path, byte size, short content summary |
| Goal state | active, paused, completed, or canceled; include pause reason when relevant |
| app-server | real child-process argv, cwd, target `CODEX_HOME` in environment |
| TUI | real child-process argv; must include `-C <node-working-directory>` |
| bridge | real child-process argv, cwd, CommHub `project_dir` |

Inspect the real child processes, not only the outer launcher, tmux name, or supervisor. Confirm that app-server, TUI, and bridge children all use the target node token, target node `CODEX_HOME`, and target working directory.

## 2. Back Up Credentials And Lock Permissions

Before restarting, migrating, or forking a node, back up the target node's Codex credential file, such as `auth.json` under the node-specific `CODEX_HOME`. After copying it, restrict it to the current user:

```bash
chmod 0600 <node-codex-home>/auth.json
```

Credentials, bearer tokens, `ntok_`, and `atok_` values must never appear in argv, logs, chat, pull requests, task replies, or screenshots. Use protected files, environment-variable references, or a platform secret store when a secret must be passed.

## 3. Stop The Old Topology In Order

Stop order:

1. bridge
2. TUI
3. app-server

After tmux sessions exit, check for orphaned child processes and orphaned listening ports. Do not start the new topology while an old port is still listening, an old bridge is still connected to the Hub, or an old TUI still owns the original thread.

When anet manages the node, prefer running this from outside the co-presence process tree:

```bash
anet node stop <alias>
```

Then verify that tmux sessions, process trees, and loopback listeners are gone.

## 4. Start In Reverse Order

Start order:

1. app-server
2. TUI
3. bridge

Both app-server and TUI must explicitly use the target node's isolated `CODEX_HOME`. The TUI must explicitly set the working directory:

```bash
codex resume --remote <app-server-url> <full-thread-id> -C <node-cwd> -m <model>
```

Before starting the bridge, `cd` into the target node working directory. After startup, verify that these three values match:

- CommHub `project_dir`
- TUI argv `-C <node-cwd>`
- the working directory recorded in the node profile

Any mismatch means recovery failed.

## 5. Resume Only The Exact Session

Do not use short prefixes, the most recent session, an interactive picker, or a historical session that merely looks related. Pass the full 36-character thread ID to `resume`.

The same thread ID can legitimately exist under different `CODEX_HOME` directories, so thread ID alone is not sufficient acceptance evidence. Also verify `CODEX_HOME`, primary rollout path, primary rollout size, working directory, and node identity.

A side-thread file cannot replace primary-session acceptance. A newly generated rollout only proves that a new session was created; it does not prove the original session was restored.

## 6. Prove The Rollout Did Not Regress

Before resume, inspect the primary rollout:

```bash
wc -c <main-rollout-file>
sed -n '1,40p' <main-rollout-file>
tail -40 <main-rollout-file>
```

After restart, inspect the same absolute path again. The byte size must not shrink, the path must not switch to a side-thread file, and the content should continue the original thread. If the file shrank, was replaced, disappeared, or no longer looks continuous, stop and compare against the pre-restart record.

## 7. Preserve The Original Goal State

Do not treat restart as a task-state reset.

- Goals that were active before restart must continue after recovery.
- Goals that were paused before restart must remain paused.
- If automatic continuation accidentally resumes a goal that should be paused, pause it immediately and record the incident in the acceptance notes.

Do not use a probe task that changes state while validating the restart.

## 8. Use Side-Effect-Free Login Probes

For identity validation, send only fixed, short, side-effect-free probes, such as asking the node to return a fixed phrase or read its own read-only status. Do not ask the probe to edit files, refresh credentials, stop processes, change goals, or call external systems.

Final identity acceptance must include a task or reply sent by the target node itself, then verified from the Hub sender fields:

- `from_name`
- `from_node_id`
- target network / project information

If the receiving model, tool, or permission layer returns a 4xx, classify only the receiving path as failed. When sender fields are correct, the sending identity can still pass. Do not misclassify receiver-side 4xx errors as sender identity failures.

## 9. Full Acceptance Checklist

Run one node as a canary first, then repeat the same checklist node by node. Finish with a fresh full-status pull for the fleet.

| Check | Pass condition |
|---|---|
| app-server | Process online; real child uses target token, `CODEX_HOME`, and cwd |
| TUI | Process online; argv contains full thread ID and `-C <node-cwd>` |
| bridge | Process online; started from target cwd; CommHub `project_dir` is correct |
| session | Full 36-character thread ID matches the pre-restart record |
| rollout | Same absolute path; byte size did not shrink; content was not replaced by a new thread |
| identity | Hub `from_name` / `from_node_id` match the target alias / node_id |
| status | Hub reports online / idle and no old duplicate instance is connected |
| goal | active continues, paused remains paused, no unexpected continuation |
| credentials | `auth.json` mode is `0600`; secrets are absent from argv, logs, and replies |

If any item fails, return to the stop condition.

## 10. Record The Result

Acceptance notes should contain general facts, not secrets:

- alias and node_id as a redacted identifier or internal ticket reference.
- Thread-ID verification result before and after restart; use a hash or suffix check when needed.
- Rollout path category, byte-size comparison, and "did not shrink" conclusion.
- Whether all three process command lines aligned to the same `CODEX_HOME`, cwd, and project_dir.
- Whether goal state matched expectation.
- Hub sender-field result for the login probe.
- Whether orphan processes, orphan ports, or side-threads were found.

Public docs, issues, pull requests, and release notes should retain only these general principles. Do not include internal paths, private addresses, machine aliases, ports, fingerprints, raw session IDs, or production SHAs.
