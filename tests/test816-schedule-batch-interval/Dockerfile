FROM oven/bun:1.3.14
WORKDIR /work/server
COPY contracts /work/contracts
# contracts/*.ts re-export ../server/src/contracts/*
COPY server/src/contracts /work/server/src/contracts
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src
COPY tests/test816-schedule-batch-interval/run.sh /work/run.sh
CMD ["bash", "/work/run.sh"]
