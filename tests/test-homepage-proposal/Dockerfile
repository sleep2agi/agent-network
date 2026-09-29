FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
WORKDIR /qa
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN npm install --no-audit --no-fund playwright@1.58.2
COPY docs/design/homepage-ui /qa/site
COPY tests/test-homepage-proposal/run.mjs /qa/run.mjs
CMD ["node", "run.mjs"]
