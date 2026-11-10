# OpenCode V2 session model sync — agent-node 2.5.0-preview.147

Software alpha: CLI 2.3.0-preview.183 / Node 2.5.0-preview.147 / existing Hub 0.9.0-preview.139. OpenCode V2 reports the TUI-selected session model on `report_status.model`. A client model change switches the live session and writes `config.json` model without restarting the process. Stable/latest unchanged.

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.147 @sleep2agi/agent-network@2.3.0-preview.183
```

## Upgrade

Upgrade both packages together, then restart only the OpenCode V2 nodes that should pick up the new runtime. Do not stop the shared OpenCode server. Do not restart unrelated nodes as part of publication.
