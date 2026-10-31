# agent-network 2.3.0-preview.202

Since `.201`: **the CLI no longer prompts when stdin is not a terminal.** That is the whole
behavioural change; the paired agent-node stays at `2.5.0-preview.168`.

| Commit | PR | What |
|---|---|---|
| 5388cab6 | — | 非 TTY 下 `ask()` 不再等待输入；`anet init` 给出 `--hub` |
| d2eec4d4 | — | version bump + paired constant |

## Behaviour

- **Bug fixed — "it just hangs and the client shows nothing".** When a desktop client spawns
  the CLI, stdin is a **pipe that stays open** (not `/dev/null`). `anet init` printed
  `CommHub URL (e.g. http://YOUR_IP:9200): ` and then waited forever: measured 6 s later the
  process was still alive with that one line on stdout. The client could not tell a hang from
  work in progress.
  Now, when stdin is not a terminal:
  - a prompt **with** a default resolves to that default and says so on stderr;
  - a prompt **without** a default fails with `non_interactive_prompt` naming what to pass;
  - `anet init` states the exact flag: `anet init --hub http://YOUR_IP:9200`;
  - type-to-confirm answers resolve to "no" (the only dangerous answer for a confirmation is
    an unintended "yes").
- **Why earlier non-TTY tests missed it.** They used `input: ""`, so stdin hit EOF immediately
  and `rl.question` returned at once. "Non-TTY" is two different shapes; only the second —
  an open, never-closed pipe — shows the hang.
- **No other CLI surface change.** Commands, flags and defaults are otherwise unchanged.
- **Paired runtime pin unchanged** (`agent-node@2.5.0-preview.168`).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.202
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.202 @sleep2agi/agent-node@2.5.0-preview.168
```
