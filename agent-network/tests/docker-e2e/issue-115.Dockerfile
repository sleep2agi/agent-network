# Focused functional test for issue #115 — anet node create --resume / picker
# + CLAUDE_CODE_RESUME_THRESHOLD_MINUTES env injection.
#
# Self-contained: a tiny mock hub (only /api/auth/node-token is exercised) and
# a `claude` shim stand in for the real stack — this suite proves the CLI
# logic on the *obfuscated* dist, not the hub/runtime.
FROM node:22-slim

WORKDIR /anet
# Obfuscated dist + manifest — exactly what npm would ship.
COPY dist ./dist
COPY package.json ./

# Test harness.
COPY tests/docker-e2e/issue-115-test.sh /test.sh
RUN chmod +x /test.sh

WORKDIR /work
ENV NODE_ENV=production
CMD ["/test.sh"]
