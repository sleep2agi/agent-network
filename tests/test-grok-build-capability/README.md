# Grok Build Capability Probe

Docker-only Phase 0 gate for the future `grok-build-acp` runtime.

Run from the repository root:

```bash
sg docker -c 'docker build -t agent-network-grok-probe -f tests/test-grok-build-capability/Dockerfile .'
sg docker -c 'docker run --rm -e GROK_CODE_XAI_API_KEY="$GROK_CODE_XAI_API_KEY" -v "$PWD/docs/tests:/work/docs/tests" agent-network-grok-probe'
```

If the host has no `GROK_CODE_XAI_API_KEY` but has a local Grok CLI login cache, run with a read-only cache mount:

```bash
sg docker -c 'docker run --rm -v "$HOME/.grok:/host-grok:ro" -v "$PWD/docs/tests:/work/docs/tests" agent-network-grok-probe'
```

Auth precedence:

1. `GROK_CODE_XAI_API_KEY`
2. read-only mounted host cache at `/host-grok`
3. clean SKIP

The probe never prints auth file contents and does not copy credentials into the repository or reports.
