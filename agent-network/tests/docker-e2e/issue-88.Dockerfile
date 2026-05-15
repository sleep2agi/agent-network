# Focused functional test for issue #88 — anet upgrade (multi-package,
# dual-channel, dry-run, --self, Node version check, registry failure).
# Self-contained: a fake `npm` shim mocks both registry queries
# (`npm view ... version`) and install actions (`npm install -g`),
# plus a fixtures dir simulates "globally installed" state per package.
FROM node:22-slim

WORKDIR /anet
COPY dist ./dist
COPY package.json ./

COPY tests/docker-e2e/issue-88-test.sh /test.sh
RUN chmod +x /test.sh

WORKDIR /work
ENV NODE_ENV=production
CMD ["/test.sh"]
