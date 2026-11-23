FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends minisign git unzip zip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY docs-site/scripts/fallback-report-policy.mjs docs-site/scripts/fallback-report-policy.test.mjs ./
COPY docs-site/scripts/fallback-report-downloads.mjs docs-site/scripts/fallback-report-downloads.test.mjs ./
COPY docs-site/scripts/fallback-report.mjs ./
RUN node --check fallback-report.mjs
COPY docs-site/scripts/record-fallback-generation.mjs docs-site/scripts/record-fallback-generation.test.mjs ./
COPY docs-site/scripts/fallback-report-generation.mjs docs-site/scripts/fallback-report-generation.test.mjs ./
COPY docs-site/scripts/fallback-report-artifact.mjs docs-site/scripts/fallback-report-artifact.test.mjs ./
COPY docs-site/scripts/fallback-report-producer.mjs docs-site/scripts/fallback-report-producer.test.mjs ./
COPY docs-site/scripts/fallback-report-checks.mjs docs-site/scripts/fallback-report-checks.test.mjs ./
CMD ["node", "--test", "fallback-report-policy.test.mjs", "fallback-report-downloads.test.mjs", "record-fallback-generation.test.mjs", "fallback-report-generation.test.mjs", "fallback-report-artifact.test.mjs", "fallback-report-producer.test.mjs", "fallback-report-checks.test.mjs"]
