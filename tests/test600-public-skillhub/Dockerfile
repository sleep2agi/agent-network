FROM node:22-bookworm-slim

ARG SOURCE_COMMIT=unknown
ENV TEST600_SOURCE_COMMIT=$SOURCE_COMMIT
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
CMD ["bash", "tests/test600-public-skillhub/run.sh"]
