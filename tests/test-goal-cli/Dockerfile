FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
COPY . /workspace

ENTRYPOINT ["bash", "tests/test-goal-cli/run.sh"]
