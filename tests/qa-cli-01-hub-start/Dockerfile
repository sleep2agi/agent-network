FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip procps && rm -rf /var/lib/apt/lists/*
# The bun installer downloads the release from github.com; a single hiccup
# there fails the whole image build, and the resulting CI red reads as if the
# code under test broke (#728 — this exact line took three L1 images down and
# blocked merges repeatedly). Retry with backoff so a transient fetch does not
# masquerade as a test failure.
#
# Note this only removes the transient half. The install is still unpinned and
# unverified, so what lands in the image depends on what bun.sh serves that
# day; pinning across all 43 test images is tracked separately in #728.
RUN for i in 1 2 3; do \
      curl -fsSL https://bun.sh/install | bash && break; \
      echo "bun install attempt $i failed; retrying in $((i*5))s"; \
      sleep $((i*5)); \
    done; \
    test -x "$HOME/.bun/bin/bun" || { echo "bun install failed after 3 attempts"; exit 1; }
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY tests/qa-cli-01-hub-start/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
