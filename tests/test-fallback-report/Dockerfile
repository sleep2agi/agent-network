FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends minisign && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY docs-site/scripts/fallback-report-policy.mjs docs-site/scripts/fallback-report-policy.test.mjs ./
COPY docs-site/scripts/fallback-report-downloads.mjs docs-site/scripts/fallback-report-downloads.test.mjs ./
COPY docs-site/scripts/fallback-report.mjs ./
RUN node --check fallback-report.mjs
CMD ["node", "--test", "fallback-report-policy.test.mjs", "fallback-report-downloads.test.mjs"]
