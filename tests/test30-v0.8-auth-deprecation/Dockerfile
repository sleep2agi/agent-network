FROM node:20

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY tests/test30-v0.8-auth-deprecation/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
