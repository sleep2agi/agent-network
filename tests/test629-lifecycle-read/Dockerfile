FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
COPY server ./server
RUN cd server && bun install --frozen-lockfile
COPY tests/test629-lifecycle-read ./tests/test629-lifecycle-read
CMD ["bash", "/app/tests/test629-lifecycle-read/run.sh"]
