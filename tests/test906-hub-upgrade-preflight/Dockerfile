# TEST-ONLY: immutable backup + exact published package, no network or live DB.
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
COPY drive.mjs /check/drive.mjs
ENTRYPOINT ["/runtime/bun", "/check/drive.mjs"]
