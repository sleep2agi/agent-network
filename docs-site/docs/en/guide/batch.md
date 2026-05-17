# Batch Agents: `anet create --batch` + `anet batch <verb>`

> Covers the batch primitive shipped as stable since v0.8.3 (issue [#55](https://github.com/sleep2agi/agent-network/issues/55)). It's on the npm `latest` tag — no need to install `@preview`. This page was migrated from `agent-network/docs/batch.md` to docs-site as the online user-facing doc.

## In one sentence

`anet create --batch` creates N agents in bulk: auto-numbered by prefix, writes each node's `config.json`, and starts the matching tmux session. Then `anet batch <verb> <prefix>` manages stop / cleanup / list across the group.

## Quick start

```bash
# Install / upgrade to latest (batch is stable since v0.8.3)
npm install -g @sleep2agi/agent-network

# Create 5 engineer agents at once
anet create --batch \
  --preset claude-haiku-4-5 \
  --api-key sk-ant-... \
  --prefix engineer \
  --count 5

# List the batch tmux group
anet batch list

# Stop all engineer nodes
anet batch stop engineer

# Stop and delete the default separate-mode workdir
anet batch cleanup engineer --workdir ~/anet-team
```

Running `anet create --batch` with no flags enters the wizard.

## Wizard fields

| Field | Flag | Default | Notes |
|------|------|------|------|
| Vendor / model | `--preset <key>` | omit → interactive **vendor picker** (shares the same `selectVendorAndModel()` implementation — ⚠ the batch wizard is still vendor-first, **unlike `anet create`'s v0.9.2+ runtime-first wizard** [#133](https://github.com/sleep2agi/agent-network/issues/133); you pick the vendor first, then the model. v0.10.5-7 incremental UX upgrades have shipped: workdir-mode prompt ([#152](https://github.com/sleep2agi/agent-network/issues/152)) / silent-exit fix ([#155](https://github.com/sleep2agi/agent-network/issues/155)) / codex-sdk batch-path yolo flags parity ([#156](https://github.com/sleep2agi/agent-network/issues/156))) | `--preset` accepts a vendor key (`intern` / `minimax` / `mimo` / `anthropic` / `codex` / `claude-code` / `custom`); for backward compat it also accepts the old model id (e.g. `intern-s1-pro`, auto-resolved back to its vendor) |
| API key | `--api-key <key>` | interactive | written as each node's runtime auth token — **codex-sdk / claude-code-cli runtimes now auto-skip the API-key prompt** (v0.10.5 [#153](https://github.com/sleep2agi/agent-network/issues/153) — users `codex auth login` / `claude auth login` instead) |
| Workdir | `--workdir <path>` | `~/anet-team` | parent directory |
| Workdir mode | `--workdir-mode separate\|shared` | `separate` | `separate` = one subdirectory per node; `shared` = all nodes write into the same `<workdir>/.anet/nodes` |
| Prefix | `--prefix <name>` | interactive | alias prefix, e.g. `engineer` → `engineer1` |
| Count | `--count <N>` | interactive | `1-50`; over 20 prints a memory / ulimit risk warning |
| Description | `--description <text>` | interactive | written into `systemPrompt`; empty → not written |
| Leader alias | `--leader-alias <name>` | off | when set, the first node uses this alias with `role=leader`, the rest are workers |

`ANET_BATCH_API_KEY` works as a fallback for `--api-key`.

## Built-in vendors (`VENDORS` list)

The `anet create --batch` wizard goes through `selectVendorAndModel()` (cli.ts `VENDORS` list) — it shares the **same vendor picker implementation** as the single-node `anet create` wizard, but since v0.9.2 [#133](https://github.com/sleep2agi/agent-network/issues/133) `anet create` got a runtime-first picker on top (batch still doesn't have one as of v0.10.8 — the runtime-first picker for batch is queued for the v0.11+ batch-wizard rework), so batch remains vendor-first. `--preset <vendor-key>` selects the vendor directly:

| `--preset` key | Runtime | Built-in models | Base URL |
|--------|---------|-------|----------|
| `intern` | `claude-agent-sdk` | intern-s2-preview (default) / intern-s1-pro | `https://chat.intern-ai.org.cn` (bare hostname) |
| `minimax` | `claude-agent-sdk` | MiniMax-M2.7 | `https://api.minimaxi.com/anthropic` |
| `mimo` | `claude-agent-sdk` | mimo-v2.5-pro (default) / v2.5 / v2-pro / v2-omni | `https://token-plan-cn.xiaomimimo.com/anthropic` |
| `anthropic` | `claude-agent-sdk` | claude-sonnet-4-6 (default) / opus-4-6 / haiku-4-5 | Anthropic native |
| `codex` | `codex-sdk` | gpt-5.4 (default) / o3 | (needs `codex auth login`) |
| `claude-code` | `claude-code-cli` | uses the Claude Code subscription model | (needs a Claude subscription) |
| `custom` | `claude-agent-sdk` | fill in your own model id | fill in your own base URL |

Every built-in vendor's `baseUrl` + model id is verified-with-real-call before it lands in `VENDORS`. Providers not on the list (DeepSeek / GLM / Kimi / OpenRouter, etc.) go through `--preset custom` with manual entry.

> Compatibility: `--preset` also accepts the old model-id values (e.g. `--preset intern-s1-pro`); cli.ts auto-resolves them back to the matching vendor.

## Lifecycle: `anet batch <verb>`

```bash
anet batch <verb> [<prefix>] [--workdir <path>]
```

| Verb | Effect | Phase 1 status |
|------|------|---------------|
| `list` | List the current tmux session group | available; known noise: also lists non-anet tmux sessions on the host shaped like `${a}-${b}` |
| `stop <prefix>` | Kill all `${prefix}-*` tmux sessions | available |
| `cleanup <prefix> --workdir <path>` | `stop` + delete `<workdir>/node*` | clean for the default `separate` mode |
| `start <prefix>` | Re-launch | Phase 1 hint-only; suggests re-running `anet create --batch` |
| `restart <prefix>` | `stop` + `start` | `stop` works, `start` is still hint-only |

::: warning shared-mode cleanup limitation
`--workdir-mode shared` writes configs to `<workdir>/.anet/nodes/<alias>/config.json`. Currently `cleanup` only auto-deletes the default separate-mode `<workdir>/node*`; shared-mode leftover configs need a manual `rm`. Phase 2 will do safe cleanup via a `~/.anet/batches.json` registry.
:::

## Directory layout

Default `workdir-mode=separate`:

```text
<workdir>/
├── node1/.anet/nodes/<alias-1>/config.json
├── node2/.anet/nodes/<alias-2>/config.json
└── nodeN/.anet/nodes/<alias-N>/config.json
```

`workdir-mode=shared`:

```text
<workdir>/.anet/nodes/
├── <alias-1>/config.json
├── <alias-2>/config.json
└── <alias-N>/config.json
```

tmux sessions are named `${team || prefix}-${alias}`, e.g.:

```text
engineer-engineer1
engineer-engineer2
sci-team-research-leader
sci-team-researcher1
```

## Relationship to `anet demo sci-team`

`anet demo sci-team` is a preset wrapper over the batch primitive; the user-facing entry stays compatible:

```bash
anet demo sci-team --count 10 --intern-api "$INTERN_API_KEY" --dir ~/intern-s
```

Internally equivalent to:

```bash
anet create --batch \
  --preset intern-s1-pro \
  --api-key "$INTERN_API_KEY" \
  --workdir ~/intern-s \
  --workdir-mode separate \
  --prefix researcher \
  --leader-alias research-leader \
  --count 10
```

The difference is that sci-team auto-writes `team="sci-team"`, `role="leader|worker"`, and the research-survey prompt.

The old `anet demo sci-team --stop|--restart|--cleanup` flags still work but print a deprecation warning — migrate to `anet batch <verb> sci-team`. A future major release may remove the legacy flags.

## Phase 1 limitations

| Limitation | Current behavior | Direction |
|------|----------|----------|
| `batch list` noise | lists some non-anet tmux sessions | add a `~/.anet/batches.json` registry |
| `start` / `restart` | hint-only | re-spawn tmux from existing configs |
| Precise shared-mode cleanup | needs manual deletion | safe cleanup once the registry lands |

## Related

- Issue [#55](https://github.com/sleep2agi/agent-network/issues/55)
- Research-squad demo PR [#53](https://github.com/sleep2agi/agent-network/pull/53)
- RFC-008: [multi-agent team convention](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-008-multi-agent-team-convention.md)
