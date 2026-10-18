FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN install -d -m 0755 /run/user && install -d -m 0700 -o bun -g bun /run/user/1000
WORKDIR /repo/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=bun:bun agent-node/src/ ./src/
COPY tests/test1120-copresence-auth/run.sh /fixture/run.sh
RUN chmod +x /fixture/run.sh
USER bun
CMD ["bash", "/fixture/run.sh"]
