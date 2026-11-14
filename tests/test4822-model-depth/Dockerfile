FROM oven/bun:1.3.14
ENV OPENCODE_V2_VERSION=2.0.22
RUN apt-get update && apt-get install -y --no-install-recommends python3 nodejs npm ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @opencode/cli@${OPENCODE_V2_VERSION} --no-audit --no-fund \
    && mkdir /tool && ln -s "$(npm root -g)/@opencode/cli/bin/opencode.exe" /tool/opencode
COPY agent-node/src /repo/agent-node/src
COPY scripts/opencode-v2-model-depth.ts /repo/scripts/opencode-v2-model-depth.ts
COPY tests/test4822-model-depth /repo/tests/test4822-model-depth
WORKDIR /repo
CMD ["bash", "tests/test4822-model-depth/run.sh"]
