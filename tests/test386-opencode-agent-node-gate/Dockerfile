FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends jq python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo/agent-network
COPY agent-network/package.json agent-network/package-lock.json ./
RUN bun install --silent
COPY agent-network/ ./

# The pairing unit test verifies the exact sibling package version. The
# agent-node OpenCode unit family below stays intentionally scoped to its six
# implementation modules and matching tests; none imports agent-node code
# outside this directory.
COPY agent-node/package.json /repo/agent-node/package.json
COPY agent-node/src/runtime/opencode-acp/ /repo/agent-node/src/runtime/opencode-acp/
COPY tests/test386-opencode-agent-node-gate/ /test/

# Real-package compatibility diagnostic for the common developer layout:
# non-root uid=gid, umask 0002 and a user-owned global package prefix. The final
# run invokes both the network and agent-node identity gates against this same
# registry payload; no hub or upstream model call is needed.
RUN mkdir -p /home/bun/prefix /home/bun/project /home/bun/probe \
  && chown -R 1000:1000 /home/bun
USER bun
RUN umask 0002 \
  && cd /home/bun/prefix \
  && HOME=/home/bun bun add --exact opencode-ai@1.18.1 \
  && chmod -R g+w /home/bun/prefix \
  && mkdir -p /home/bun/.config /home/bun/.local/share \
      /home/bun/.cache /home/bun/.local/state
USER root

RUN chmod 755 /test/run.sh /test/bin/* /test/fail-bin/* /test/capable-bin/* /test/profile-bin/* \
      /test/project-bin/* \
  && chmod 644 /test/loader-canary.cjs \
  && chmod 644 /test/exact-node/package.json \
  && chmod 755 /test/exact-node/dist/cli.js \
  && chmod 644 /test/project-agent-node/package.json \
  && chmod 755 /test/project-agent-node/dist/cli.js \
  && chmod 644 /test/stale-capable-node/package.json \
  && chmod 755 /test/stale-capable-node/dist/cli.js \
  && mkdir -p /test/opencode-global/node_modules/opencode-ai/bin \
      /test/exact-global/node_modules/@sleep2agi/agent-node/dist \
      /test/stale-global/node_modules/@sleep2agi/agent-node/dist \
      /test/exact-bin /test/opencode-only-bin \
      /test/project-work/node_modules/opencode-ai/bin \
      /test/project-work/node_modules/@sleep2agi/agent-node/dist \
      /test/project-work/local-bin \
  && mv /test/bin/opencode /test/opencode-global/node_modules/opencode-ai/bin/opencode.exe \
  && cp /test/opencode-package.json /test/opencode-global/node_modules/opencode-ai/package.json \
  && cp /test/exact-node/package.json /test/exact-global/node_modules/@sleep2agi/agent-node/package.json \
  && cp /test/exact-node/dist/cli.js /test/exact-global/node_modules/@sleep2agi/agent-node/dist/cli.js \
  && cp /test/stale-capable-node/package.json /test/stale-global/node_modules/@sleep2agi/agent-node/package.json \
  && cp /test/stale-capable-node/dist/cli.js /test/stale-global/node_modules/@sleep2agi/agent-node/dist/cli.js \
  && mv /test/project-bin/opencode /test/project-work/node_modules/opencode-ai/bin/opencode.exe \
  && cp /test/opencode-package.json /test/project-work/node_modules/opencode-ai/package.json \
  && mv /test/project-agent-node/dist/cli.js /test/project-work/node_modules/@sleep2agi/agent-node/dist/cli.js \
  && cp /test/project-agent-node/package.json /test/project-work/node_modules/@sleep2agi/agent-node/package.json \
  && chmod 755 /test/opencode-global/node_modules/opencode-ai/bin/opencode.exe \
      /test/exact-global/node_modules/@sleep2agi/agent-node/dist/cli.js \
      /test/stale-global/node_modules/@sleep2agi/agent-node/dist/cli.js \
      /test/project-work/node_modules/opencode-ai/bin/opencode.exe \
      /test/project-work/node_modules/@sleep2agi/agent-node/dist/cli.js \
  && chmod 644 /test/opencode-global/node_modules/opencode-ai/package.json \
      /test/exact-global/node_modules/@sleep2agi/agent-node/package.json \
      /test/stale-global/node_modules/@sleep2agi/agent-node/package.json \
      /test/project-work/node_modules/opencode-ai/package.json \
      /test/project-work/node_modules/@sleep2agi/agent-node/package.json \
  && ln -s /test/opencode-global/node_modules/opencode-ai/bin/opencode.exe /test/bin/opencode \
  && ln -s /test/opencode-global/node_modules/opencode-ai/bin/opencode.exe /test/opencode-only-bin/opencode \
  && ln -s /test/exact-global/node_modules/@sleep2agi/agent-node/dist/cli.js /test/exact-bin/agent-node \
  && ln -s /test/project-work/node_modules/opencode-ai/bin/opencode.exe /test/project-work/local-bin/opencode \
  && ln -s /test/project-work/node_modules/@sleep2agi/agent-node/dist/cli.js /test/project-work/local-bin/agent-node \
  && ln -s /test/stale-global/node_modules/@sleep2agi/agent-node/dist/cli.js /test/capable-bin/agent-node

CMD ["/test/run.sh"]
