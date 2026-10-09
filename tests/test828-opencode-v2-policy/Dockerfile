FROM oven/bun:1.3.14 AS bun
FROM node:22-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install -g @opencode/cli@2.0.22 && test "$(opencode --version)" = 'opencode v2.0.22'
COPY tests/test828-opencode-v2-policy /test828
ENTRYPOINT ["bash", "/test828/run.sh"]
