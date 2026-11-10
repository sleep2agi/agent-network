#!/bin/sh
# TEST ONLY, inside the previously built test906 Docker image.
# /candidate is read-only candidate source; copy metadata and exact pair pins.
set -eu
for package_dir in agent-network agent-node; do
  cp "/candidate/$package_dir/package.json" "/work/$package_dir/package.json"
  cp "/candidate/$package_dir/package-lock.json" "/work/$package_dir/package-lock.json"
done
cp /candidate/agent-network/src/opencode-agent-node-pair.ts /work/agent-network/src/opencode-agent-node-pair.ts
cp /candidate/agent-network/src/opencode-agent-node-pair.test.ts /work/agent-network/src/opencode-agent-node-pair.test.ts
cd /work
# Fail at the version-pair layer before building/running the creation layer.
install -d -m 700 -o runner -g runner /run/user/10001
runuser -u runner -- bun test --bail agent-network/src/opencode-agent-node-pair.test.ts
cd /work/agent-network
bun build bin/cli.ts --target node --outfile dist/bin/cli.js --external @sleep2agi/commhub-server --external bun:sqlite --external '../../server/*'
node dist/bin/cli.js --version | grep -F '2.3.0-preview.166'
cd /work
bun -e 'const pairs = [["agent-network", "2.3.0-preview.166"], ["agent-node", "2.5.0-preview.132"], ["server", "0.9.0-preview.124"]]; for (const [dir, expected] of pairs) { const p = await Bun.file(`/candidate/${dir}/package.json`).json(); const l = await Bun.file(`/candidate/${dir}/package-lock.json`).json(); if(p.version !== expected || l.version !== expected || l.packages[""].version !== expected) throw new Error(`candidate lock mismatch: ${dir}`); } console.log("PASS candidate3/3 exact package+lock versions; no runtime package publication claim");'
runuser -u runner -- bun test --bail agent-network/src/daemon-provider-initialize.test.ts tests/test906-provider-create/core.test.ts
