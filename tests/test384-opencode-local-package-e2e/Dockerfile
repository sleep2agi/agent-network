FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.1
ARG AGENT_NETWORK_VERSION=2.3.0-preview.39
ARG AGENT_NODE_VERSION=2.5.0-preview.31

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq procps python3 python3-pexpect ripgrep unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Build the two release artifacts from the checked-out source.  npm pack is
# deliberately run with scripts disabled after the explicit build so the
# tarball under test is exactly the already-inspected build output.
WORKDIR /repo/agent-network
COPY agent-network/package.json agent-network/package-lock.json ./
RUN npm ci --ignore-scripts
COPY agent-network/ ./
RUN npm run build \
    && mkdir -p /artifacts \
    && npm pack --ignore-scripts --pack-destination /artifacts

WORKDIR /repo/agent-node
COPY agent-node/package.json ./
RUN npm install --ignore-scripts --omit=optional
COPY agent-node/ ./
RUN npm run build \
    && npm pack --ignore-scripts --pack-destination /artifacts

# Install only the locally-packed release candidates. Optional SDK runtimes
# are omitted because this suite exercises the native opencode-cli path.
RUN npm install -g --omit=optional \
      /artifacts/sleep2agi-agent-node-*.tgz \
      /artifacts/sleep2agi-agent-network-*.tgz

# The hub is started from this checkout with its own /tmp SQLite DB; it never
# contacts, reads, or mutates a production hub/database.
WORKDIR /repo/server
COPY server/package.json ./
RUN bun install --production --silent
COPY server/ ./

# Exact upstream pin under verification.  Never install opencode-ai@latest in
# this release gate.
RUN npm install -g --omit=optional "opencode-ai@${OPENCODE_VERSION}" --silent \
    && test "$(opencode --version | tr -d '\r\n')" = "${OPENCODE_VERSION}" \
    && timeout 20 opencode acp --help >/dev/null

WORKDIR /test384
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY tests/test384-opencode-local-package-e2e/run.sh /test384/run.sh
COPY tests/test384-opencode-local-package-e2e/wizard_probe.py /test384/wizard_probe.py
COPY tests/test384-opencode-local-package-e2e/auth_login_probe.py /test384/auth_login_probe.py
COPY tests/test384-opencode-local-package-e2e/fake_opencode.py /test384/fake-global/node_modules/opencode-ai/bin/opencode.exe
COPY tests/test384-opencode-local-package-e2e/fake_opencode_package.json /test384/fake-global/node_modules/opencode-ai/package.json
COPY tests/test384-opencode-local-package-e2e/project_local_opencode.sh /test384/project-local-opencode
COPY tests/test384-opencode-local-package-e2e/profile_stale_opencode.py /test384/profile-stale-bin/opencode
COPY tests/test384-opencode-local-package-e2e/assert_security_dump.py /test384/assert_security_dump.py
COPY tests/test384-opencode-local-package-e2e/ancestor_plugin.mjs /test384/ancestor_plugin.mjs
RUN mkdir -p /test384/fake-bin \
    && ln -s /test384/fake-global/node_modules/opencode-ai/bin/opencode.exe \
      /test384/fake-bin/opencode \
    && chmod 0755 /test384/run.sh /test384/wizard_probe.py /test384/auth_login_probe.py \
      /test384/fake-global/node_modules/opencode-ai/bin/opencode.exe \
      /test384/project-local-opencode /test384/profile-stale-bin/opencode \
      /test384/assert_security_dump.py \
    && chmod 0644 /test384/fake-global/node_modules/opencode-ai/package.json

ENV OPENCODE_VERSION_UNDER_TEST=${OPENCODE_VERSION}
ENV AGENT_NETWORK_VERSION_UNDER_TEST=${AGENT_NETWORK_VERSION}
ENV AGENT_NODE_VERSION_UNDER_TEST=${AGENT_NODE_VERSION}
CMD ["/test384/run.sh"]
