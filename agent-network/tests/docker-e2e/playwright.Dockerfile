# Pre-bake Playwright + tests so the runner starts in seconds.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /tests
COPY playwright/package.json /tests/package.json
RUN npm install --no-audit --no-fund --silent

# Test files are mounted at runtime via docker-compose so iterating on
# them doesn't require a rebuild.
ENV CI=1
CMD ["npx", "playwright", "test", "--reporter=list,junit"]
