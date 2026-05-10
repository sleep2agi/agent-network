# Debate Demo

`anet demo debate` is the current built-in demo. The CLI creates 6 temporary agents, drives a full 9-step debate, and writes a markdown transcript.

## One Command

```bash
anet demo debate --topic "Will AI create more jobs than it destroys?"
```

It usually takes 8-12 minutes. Log in to a hub first and provide a MiniMax API key:

```bash
export MINIMAX_KEY=sk-cp-...
```

## Roles

| Role | Name | Responsibility |
|------|------|----------------|
| Host | Zhou | Opening and closing |
| Pro 1 | Lin Xi | Opening statement and summary |
| Pro 2 | Chen Yichuan | Cross-examines the con side |
| Con 1 | Shen Mo | Opening statement and summary |
| Con 2 | Bai Chuan | Cross-examines the pro side |
| Judge | Prof. Zhang | Scores and declares the winner |

## Flow

1. Host opening
2. Pro opening statement
3. Con opening statement
4. Pro cross-examination
5. Con cross-examination
6. Con summary
7. Pro summary
8. Judge scoring
9. Host closing

Use `--quick` for the 4-step version: opening, both statements, and judging.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--topic <text>` | prompt | Debate topic |
| `--key <key>` | `$MINIMAX_KEY` | MiniMax API key |
| `--out <path>` | `./debate-<topic>-<ts>.md` | Transcript path |
| `--keep` | false | Keep the 6 temporary agents and isolated network |
| `--quick` | false | 4-step flow |
| `--step-timeout <s>` | 360 | Per-step timeout |
| `--suffix <s>` | random 4 hex | Alias suffix |
| `--no-network` | false | Use the current/default network |
| `--network <id>` | none | Use an existing network |

## Network Isolation

By default, `anet demo debate` creates a dedicated network for each run:

1. Create `debate-<suffix>`.
2. Provision all 6 temporary agents in that network.
3. Dispatch tasks with `network_id`.
4. Delete the agents and cascade-delete the network's tasks, inbox, and nodes after the run.

Keep the run for Dashboard inspection:

```bash
anet demo debate --keep --topic "..."
```

Reuse an existing network:

```bash
anet demo debate --network net_xxx --topic "..."
```

Use the legacy current/default network behavior:

```bash
anet demo debate --no-network --topic "..."
```

## Troubleshooting

**Missing MiniMax key**

Pass `--key` or set `MINIMAX_KEY`. The demo uses MiniMax's Anthropic-compatible endpoint.

**Step timeout**

The first claude-agent-sdk runtime startup can take a few minutes. Increase `--step-timeout 600`, or start an agent once before recording the demo.

**Keep the run**

Use `--keep`, then clean up manually:

```bash
tmux ls | grep debate-<suffix>- | awk -F: '{print $1}' | xargs -I{} tmux kill-session -t {}
anet network delete net_xxx
```
