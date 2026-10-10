FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm python3 tmux procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.18.34 --no-audit --no-fund && test "$(opencode --version)" = 1.18.34
RUN install -d -m 0755 /run/user && install -d -m 0700 -o bun -g bun /run/user/1000
WORKDIR /agent-node-src
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY agent-node/ /agent-node-src/
COPY tests/test543-opencode-v2-copresence/stub-model.py /fixture/stub-model.py
COPY tests/test894-v1-runtime/ /fixture/
ENV TERM=xterm-256color
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
USER bun
CMD ["bash", "/fixture/run.sh"]
