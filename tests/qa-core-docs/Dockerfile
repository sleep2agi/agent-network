FROM node:22-bookworm

WORKDIR /workspace/docs-site
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci

WORKDIR /workspace
COPY docs-site ./docs-site
COPY tests/qa-core-docs/run.mjs ./tests/qa-core-docs/run.mjs

CMD ["node", "tests/qa-core-docs/run.mjs"]
