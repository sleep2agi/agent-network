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

# Give the deterministic launcher the same package-owned identity as the
# upstream executable. The runtime now rejects loose same-version shims before
# it opens ACP, so this layout is part of the integration boundary under test.
RUN mkdir -p /harness/mock-global/node_modules/opencode-ai/bin \
  && cat > /harness/mock-global/node_modules/opencode-ai/bin/opencode.exe <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "1.18.1"
  exit 0
fi
exec node /harness/mock-opencode.mjs
SH
RUN cat > /harness/mock-global/node_modules/opencode-ai/package.json <<'JSON'
{
  "name": "opencode-ai",
  "version": "1.18.1",
  "bin": {
    "opencode": "bin/opencode.exe"
  }
}
JSON
RUN mkdir -p /harness/mock-bin \
  && chmod 0755 /harness/mock-global/node_modules/opencode-ai/bin/opencode.exe \
  && chmod 0644 /harness/mock-global/node_modules/opencode-ai/package.json \
  && ln -s /harness/mock-global/node_modules/opencode-ai/bin/opencode.exe \
    /harness/mock-bin/opencode

RUN cat > /harness/package.json <<'JSON'
{
  "name": "test-rfc029-pr2-harness",
  "type": "module",
  "dependencies": {}
}
JSON

RUN chmod +x /harness/run.sh

CMD ["bash", "/harness/run.sh"]
