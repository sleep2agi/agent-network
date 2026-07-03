# RFC-029 PR② — CI-gating ACP shim e2e container.
#
# Real bun + real agent-node TS source (bind-mounted). Vendor
# boundary MOCKED via `mock-opencode.mjs` — the mock is spawned by
# the runtime exactly like the real opencode CLI, so we exercise
# client.ts + events.ts + runtime.ts real code paths with a
# byte-shape identical to Phase 0b's u8-acp.txt dump.

FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /harness

COPY agent-node /agent-node-src
COPY tests/test-rfc029-pr2-acp-shim/mock-opencode.mjs /harness/mock-opencode.mjs
COPY tests/test-rfc029-pr2-acp-shim/harness.ts /harness/harness.ts
COPY tests/test-rfc029-pr2-acp-shim/run.sh /harness/run.sh

# Small launcher so the runtime's spawn(bin, ['acp']) call runs the
# mock instead of the real opencode CLI. The launcher just ignores
# the `acp` positional and execs the mock script.
RUN cat > /harness/mock-opencode-launcher.sh <<'SH' && chmod +x /harness/mock-opencode-launcher.sh
#!/usr/bin/env bash
exec node /harness/mock-opencode.mjs
SH

RUN cat > /harness/package.json <<'JSON'
{
  "name": "test-rfc029-pr2-harness",
  "type": "module",
  "dependencies": {}
}
JSON

RUN chmod +x /harness/run.sh

CMD ["bash", "/harness/run.sh"]
