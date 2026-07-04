# RFC-029 PR④ — kernel-live ACP e2e container.
#
# Real opencode-ai@1.17.13 (pinned) driven end-to-end through the real
# agent-node runtime (openOpencodeRuntime + opencodeThink from #386).
# No mock at the vendor boundary — the child process really is
# `opencode acp`, the protocol frames really are ACP JSON-RPC, and the
# reply text really comes back from a live free model.
#
# Free vendor path only — no Anthropic / OpenAI key needed. The
# configured model is one of opencode's zen-free tier:
#   opencode/deepseek-v4-flash-free  (default this harness picks)
#   opencode/mimo-v2.5-free
#   opencode/nemotron-3-ultra-free
#   opencode/north-mini-code-free
# Free-tier zen models don't require an `opencode auth login` — a
# fresh container reaches them out of the box.

FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates procps nodejs npm && \
    rm -rf /var/lib/apt/lists/*

# Pin opencode to the exact version RFC-029 PR② verified against.
RUN npm i -g opencode-ai@1.17.13 --silent && opencode --version

WORKDIR /harness

COPY agent-node /agent-node-src
COPY tests/test-rfc029-pr4-kernel-live/harness.ts /harness/harness.ts
COPY tests/test-rfc029-pr4-kernel-live/run.sh     /harness/run.sh

RUN cat > /harness/package.json <<'JSON'
{
  "name": "test-rfc029-pr4-kernel-live-harness",
  "type": "module",
  "dependencies": {}
}
JSON

RUN chmod +x /harness/run.sh

CMD ["bash", "/harness/run.sh"]
