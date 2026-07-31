FROM node:22-bookworm

WORKDIR /workspace/docs-site
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci

WORKDIR /workspace
COPY README.md README.en.md ./
COPY docs-site ./docs-site
COPY docs ./docs
COPY tests/qa-frontdoor-docs/run.mjs ./tests/qa-frontdoor-docs/run.mjs

CMD ["node", "tests/qa-frontdoor-docs/run.mjs"]
