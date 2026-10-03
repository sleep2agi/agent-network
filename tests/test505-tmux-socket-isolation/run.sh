#!/usr/bin/env bash
# #505 — tmux socket isolation, against a real default server with an inherited $TMUX.
# Runs ONLY in its Docker image: it starts and kills tmux sessions on the default
# server, which on a real host is where the fleet lives.
set -euo pipefail

[[ -f /.dockerenv ]] || { echo "FAIL: test505 runs only inside its Docker image (it drives the default tmux server)" >&2; exit 1; }
SOURCE_COMMIT=${TEST505_SOURCE_COMMIT:-}
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: SOURCE_COMMIT must be one full lowercase Git SHA" >&2; exit 1; }
echo "# test505 — tmux socket isolation (source_commit=$SOURCE_COMMIT)"

cd /workspace
SUITE=tests/test505-tmux-socket-isolation
rc=0
for pkg in agent-network agent-node; do
  bun "$SUITE/isolation.ts" "$pkg" || rc=1
done

# Witnessed red: the same checks against a helper whose TMUX_TMPDIR isolation is
# switched off must FAIL — otherwise the green above proves nothing.
echo "# test505 mutation — TMUX_TMPDIR isolation disabled, expecting red"
mkdir -p /tmp/mut
ANCHOR='  if (tmpdir) return { socket:'
grep -qF "$ANCHOR" agent-network/src/tmux.ts || { echo "FAIL: mutation anchor missing (MUTATION_NOOP)"; exit 1; }
sed "s/^  if (tmpdir) return { socket:/  if (false) return { socket:/" agent-network/src/tmux.ts > /tmp/mut/tmux.ts
cmp -s agent-network/src/tmux.ts /tmp/mut/tmux.ts && { echo "FAIL: mutation changed nothing (MUTATION_NOOP)"; exit 1; }
mut_out=$(bun "$SUITE/isolation.ts" mutant /tmp/mut/tmux.ts 2>&1 || true)
printf '%s\n' "$mut_out" | grep -E 'FAIL|Results' || true
if printf '%s\n' "$mut_out" | grep -qE 'Results: [0-9]+ passed, [1-9][0-9]* failed'; then
  echo "  PASS mutant is red"
else
  echo "  FAIL mutant stayed green — the checks do not detect a missing isolation"; rc=1
fi

[[ $rc -eq 0 ]] && echo "# test505 PASS" || echo "# test505 FAIL"
exit "$rc"
