# TEST-ONLY. No host credentials, local packages or production state.
FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
WORKDIR /browser
RUN npm install --ignore-scripts --no-audit --no-fund playwright@1.58.2
WORKDIR /site
COPY docs-site/package.json docs-site/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY docs-site/ ./
COPY tests/test961-download-platforms/ /suite/
RUN node scripts/desktop-downloads.test.mjs && npx --no-install vitepress build docs
CMD ["node", "/suite/drive.mjs"]
