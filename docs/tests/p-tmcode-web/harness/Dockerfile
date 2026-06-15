FROM node:24-slim

# Lightweight base — only what the harness needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq procps \
    && rm -rf /var/lib/apt/lists/*

# tmcode CLI — version is pinned via BUILD arg (passed at docker build time).
# Default points to @next (the tag SDK马 will publish the web-fix into).
# When SDK马 confirms a specific build version, override via:
#   docker build --build-arg TMCODE_VERSION=1.18.9 -f Dockerfile -t tmcode-web:v . --no-cache
ARG TMCODE_VERSION=next
RUN npm install -g @tianma-ai/tmcode@${TMCODE_VERSION} --no-audit --no-fund 2>&1 | tail -5
RUN tmcode --version 2>&1 | head -3

COPY entry.sh /entry.sh
RUN chmod +x /entry.sh

RUN mkdir -p /artifacts && chmod 0777 /artifacts
WORKDIR /work

CMD ["/entry.sh"]
