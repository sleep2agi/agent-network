# agent-node 2.5.0-preview.109

Since `.108` (release merge `1ff904b3`, #2387), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 4e4cc705 | #2388 | #557 items 4–5: claude SDK turns can't promise background follow-ups; no claude.ai connectors by default |

## Behaviour

- **No background work that outlives the reply.** claude-agent-sdk children start with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (CLI 2.1.289 removes `run_in_background` from the Bash tool and refuses background agents). Two sentences go in front of the system prompt: the final reply ends the task and anything still running is stopped, so finish in the foreground and never promise a later follow-up. Order: intern bias → this notice → the operator's systemPrompt (unchanged, still `{type:"custom", prompt, snapshot:false}`). **Behaviour change:** long commands now have to finish in the foreground, within the Bash tool's timeout.
- **No claude.ai account connectors by default.** Nodes logged in with OAuth used to load the account's claude.ai connectors (e.g. Claude Docs) into their tool list; `strictMcpConfig` does not stop that. Children now get `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Opt back in per node with `flags.claudeAiConnectors: true` in the node config (edit the file; not in the remote config-apply list). Not verified against a real OAuth login — evidence is the CLI code plus an offline SDK run whose debug log shows `[claudeai-mcp] Disabled via env var`.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.109
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.142 @sleep2agi/agent-node@2.5.0-preview.109
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.142 ↔ agent-node@2.5.0-preview.109`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.109` first, then agent-network `.142`, both from the same merge commit.

## Evidence

- #2388: 9 new unit tests (`claude-sdk-turn-options.test.ts`), each witnessed red when its behaviour is reverted; offline Docker run with the real SDK 0.3.289 / CLI 2.1.289 against a fake `/v1/messages`: `run_in_background` absent from the Bash schema with the new env, present with the old; connector fetch disabled by env. test725 2369 pass / 1 skip / 0 fail; test656 8/8; 126/126 checks.

## promote 时的 must_contain

`"version": "2.5.0-preview.109"`
