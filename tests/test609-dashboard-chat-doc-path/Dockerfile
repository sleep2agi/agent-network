FROM node:22-bookworm-slim

WORKDIR /workspace

COPY docs-site/package.json docs-site/package-lock.json ./docs-site/
RUN npm ci --prefix docs-site --no-audit --no-fund

COPY README.md README.en.md ./
COPY docs-site ./docs-site
COPY tests/dashboard-chat-doc-path.test.mjs ./tests/dashboard-chat-doc-path.test.mjs
COPY tests/test609-dashboard-chat-doc-path ./tests/test609-dashboard-chat-doc-path

ARG SOURCE_COMMIT
ENV TEST609_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test609-dashboard-chat-doc-path/run.sh
ENTRYPOINT ["/workspace/tests/test609-dashboard-chat-doc-path/run.sh"]
