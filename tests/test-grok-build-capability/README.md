# Grok Build Capability Probe

This suite validates whether Grok Build can be used as an Agent Network runtime.

Run from the repository root:

```bash
sg docker -c 'docker build -t agent-network-grok-probe -f tests/test-grok-build-capability/Dockerfile .'
sg docker -c 'docker run --rm -e GROK_CODE_XAI_API_KEY="$GROK_CODE_XAI_API_KEY" -v "$PWD/docs/tests:/work/docs/tests" agent-network-grok-probe'
```

Without `GROK_CODE_XAI_API_KEY`, authenticated checks are marked `SKIP` and the verdict remains `Wait`.
