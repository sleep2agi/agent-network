# Pre-bake the dashboard install so the e2e stack starts fast.
# Without this, the first run takes ~3-5min waiting for npm to fetch
# next + react + all transitive deps. Baked, it starts in ~10s.
FROM node:20-alpine

WORKDIR /app

# Pre-install the published preview tag. The package self-contains a
# pre-built .next dir, so all we need is the runtime deps (next, react,
# react-dom, swr — declared in its package.json).
RUN npm install --no-audit --no-fund --silent \
    @sleep2agi/agent-network-dashboard@0.1.0-preview.7

# Optional: warm next's binary so the first start is quicker.
ENV NODE_ENV=production
ENV PORT=3000

# The dashboard's bin/start.js spawns `npx next start -p $PORT`. Since
# we pre-installed everything, npx finds it locally on the first try.
WORKDIR /app/node_modules/@sleep2agi/agent-network-dashboard
EXPOSE 3000
CMD ["node", "bin/start.js"]
