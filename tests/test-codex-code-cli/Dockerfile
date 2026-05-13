FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    jq \
    procps \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# bun (for hub spawn) + codex CLI (subject under test) + anet (preview).
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Pin codex CLI to the version validated in RFC-005 §6.1 (≥ 0.128.0 required
# for inline `--config` MCP injection; 0.130.0 is what RFC-005 §7.1 specifies).
RUN npm install -g @openai/codex@0.130.0

COPY tests/test-codex-code-cli/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["bash", "/app/run.sh"]
