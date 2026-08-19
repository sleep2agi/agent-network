FROM node:22-bookworm

WORKDIR /workspace/docs-site
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci

WORKDIR /workspace
COPY README.md README.en.md ./
COPY docs-site ./docs-site
COPY docs ./docs
COPY tests/qa-frontdoor-docs/run.mjs ./tests/qa-frontdoor-docs/run.mjs

ARG SOURCE_COMMIT=dev
ENV SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["node", "tests/qa-frontdoor-docs/run.mjs"]
