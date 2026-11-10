FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install -g @opencode/cli@2.0.22 && test "$(opencode --version)" = 'opencode v2.0.22'
COPY tests/test828-opencode-v2-policy /test828
ENTRYPOINT ["bash", "/test828/run.sh"]
