ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
ARG SOURCE_COMMIT
ENV TEST1225_SOURCE_COMMIT=$SOURCE_COMMIT
# Pinned bun, per the ratchet in .github/scripts/check-bun-install-pin.py.
# 版本 + 校验和抄自 tests/test750-codex-copresence-onecommand/Dockerfile。
# 🔴 ENV,不是 ARG：hub-orphan-gates 那个 job 会把 Dockerfile 里每个 `^ARG NAME`
#    都传成 `--build-arg NAME=$GITHUB_SHA`,BUN_VERSION 一旦是 ARG 就会被写成
#    一个 commit sha,下载直接坏掉。只有 SOURCE_COMMIT 需要那个待遇。
ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 tmux unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun-linux-x64.zip \
  && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum --check --strict \
  && unzip -j /tmp/bun-linux-x64.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/bun \
  && test "$(bun --version)" = "$BUN_VERSION" \
  && rm -f /tmp/bun-linux-x64.zip
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /workspace
COPY server/package.json server/package-lock.json ./server/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
# --ignore-scripts：本套件只驱动 CLI 的编排路径、从不开 PTY,node-pty 的原生构建
# 在这里是纯负担。CLI 若哪天在 import 期真需要它,这一步会响亮地失败而不是静默。
RUN cd server && npm ci --ignore-scripts \
 && cd ../agent-network && npm ci --ignore-scripts

COPY . /workspace
RUN rm -rf /workspace/.git /workspace/.anet

ENTRYPOINT ["bash", "tests/test1225-opencode-copresence-onecommand/run.sh"]
