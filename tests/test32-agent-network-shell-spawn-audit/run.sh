#!/usr/bin/env bash
set -Eeuo pipefail

cd /app

echo "[L0] install agent-network dependencies"
(cd agent-network && bun install)

echo "[L1] typecheck agent-network"
(cd agent-network && bun tsc --noEmit)

echo "[L2] no child_process.spawn / execSync call uses shell option (true or path)"
# Round 2 (issue #86 patch): cover shell:true + shell:"/bin/bash" + shell:'/path/to/sh' 同类漏洞
# Original regex only matched shell:true; expanded to any shell:VALUE in spawn/execSync.
if grep -nE '(spawn|execSync)\([^)]*shell:' agent-network/bin/cli.ts; then
  echo "found unsafe (spawn|execSync)(... shell: ...)"
  exit 1
fi

echo "[L3] tmux demo commands do not use shell-string execSync"
if grep -nE 'execSync\(`tmux (new-session|kill-session)' agent-network/bin/cli.ts; then
  echo "found shell-string tmux execSync"
  exit 1
fi

echo "[L4] safe tmux helper quotes aliases for shell-command payload"
grep -q 'function shellQuote' agent-network/bin/cli.ts
grep -q 'function startNodeTmuxSession' agent-network/bin/cli.ts
grep -q 'anet node start ${shellQuote(alias)}' agent-network/bin/cli.ts

echo "[L5] no JSON.stringify in shell-bound command strings (round 2 cleanup)"
# Round 2 finding: JSON.stringify(var) inside shell-interpreted strings does NOT prevent injection
# ($() / `` / ${} still expand inside ". Patched 5 spots to execFileSync + array args.
if grep -nE 'execSync\([^)]*JSON\.stringify' agent-network/bin/cli.ts; then
  echo "found execSync with JSON.stringify (insufficient shell escape)"
  exit 1
fi

echo "PASS test32 agent-network shell spawn audit"
