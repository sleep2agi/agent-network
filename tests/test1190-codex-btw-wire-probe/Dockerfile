FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# PR0 deliberately pins the protocol under test. A version bump requires a
# fresh golden capture and review; "latest" would make the evidence mutable.
RUN npm install -g --no-audit --no-fund @openai/codex@0.148.0

WORKDIR /probe
COPY tests/test1190-codex-btw-wire-probe /probe/
COPY tests/lib /tests/lib/
RUN chmod +x /probe/run.sh

CMD ["/probe/run.sh"]
