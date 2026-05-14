FROM oven/bun:1

WORKDIR /app
COPY agent-network/bin/demos/opinion-spread-prompts.ts \
     agent-network/bin/demos/opinion-spread-prompts.test.ts \
     ./

# bun test auto-discovers *.test.ts — no external imports needed because
# the test only imports its sibling .ts file (no agent-network runtime deps).
CMD ["bun", "test", "opinion-spread-prompts.test.ts"]
