# OpenCode V2 shared server reuse — agent-network 2.3.0-preview.180

Software alpha: CLI 2.3.0-preview.180 / Node 2.5.0-preview.146 / existing Hub 0.9.0-preview.139. This pair adds registered OpenCode V2 shared-server reuse. Publication still requires the formal release gates. Stable/latest unchanged.

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.180 @sleep2agi/agent-node@2.5.0-preview.146
```

## Upgrade

Upgrade both packages together. Existing V2 nodes reuse `~/.anet/opencode-shared-server.json` when present. Do not restart a live node as part of publication.
