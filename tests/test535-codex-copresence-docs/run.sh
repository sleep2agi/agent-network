#!/usr/bin/env bash
set -u

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_file() {
  local path="$1"
  local label="$2"
  if [[ -f "$path" ]]; then pass "$label"; else fail "$label: missing $path"; fi
}

check_grep() {
  local pattern="$1"
  local path="$2"
  local label="$3"
  if grep -Eq -- "$pattern" "$path"; then pass "$label"; else fail "$label"; fi
}

check_absent() {
  local pattern="$1"
  local path="$2"
  local label="$3"
  if grep -Eq -- "$pattern" "$path"; then fail "$label"; else pass "$label"; fi
}

ZH=docs-site/docs/guide/codex-copresence.md
EN=docs-site/docs/en/guide/codex-copresence.md
RFC=docs/rfcs/RFC-030-codex-tui-bridge.md
SOP=docs/sop/codex-app-server-jam-restart.md

echo "========================================="
echo " Codex co-presence documentation gate"
echo "========================================="

echo
echo "A. Canonical pages and channel boundary"
check_file "$ZH" "Chinese guide exists"
check_file "$EN" "English guide exists"
check_grep 'preview-only.*latest.*完全不含|preview-only.*完全不在.*latest' "$ZH" "Chinese guide says feature is absent from latest"
check_grep 'preview-only.*latest.*contains none|completely absent from npm `latest`' "$EN" "English guide says feature is absent from latest"
check_grep 'anet upgrade --channel preview' "$ZH" "Chinese guide gives preview-channel upgrade"
check_grep 'anet upgrade --channel preview' "$EN" "English guide gives preview-channel upgrade"

echo
echo "B. First-class lifecycle and identity safety"
check_grep 'anet node start codex-human --copresence' "$ZH" "Chinese start uses first-class co-presence"
check_grep 'anet node start codex-human --copresence' "$EN" "English start uses first-class co-presence"
check_grep 'tmux attach -t =codex-human' "$ZH" "Chinese attach uses exact tmux target"
check_grep 'tmux attach -t =codex-human' "$EN" "English attach uses exact tmux target"
check_grep 'tmux capture-pane -t =codex-human' "$ZH" "Chinese diagnosis uses exact tmux target"
check_grep 'tmux capture-pane -t =codex-human' "$EN" "English diagnosis uses exact tmux target"
check_absent 'tmux (attach|capture-pane|send-keys) -t codex-human' "$ZH" "Chinese guide has no fuzzy co-presence target"
check_absent 'tmux (attach|capture-pane|send-keys) -t codex-human' "$EN" "English guide has no fuzzy co-presence target"
check_grep '前缀匹配' "$ZH" "Chinese guide warns about tmux prefix matching"
check_grep 'Prefix matching' "$EN" "English guide warns about tmux prefix matching"
check_grep 'TM副责人.*2 天.*A站副责人.*9 天' "$ZH" "Chinese guide names both production duplicate cases"
check_grep 'TM副责人.*two days.*A站副责人.*nine days' "$EN" "English guide names both production duplicate cases"
check_grep '普通.*start.*争抢同一 alias|普通 `start`.*争抢同一 alias' "$ZH" "Chinese recovery warns against plain start"
check_grep 'plain `start`.*competes.*same alias|plain `anet node start`.*competes.*same alias' "$EN" "English recovery warns against plain start"
check_grep 'for v in .*COMMHUB_.*do unset' "$ZH" "Chinese guide clears the complete COMMHUB variable family"
check_grep 'for v in .*COMMHUB_.*do unset' "$EN" "English guide clears the complete COMMHUB variable family"
check_grep 'app-server.*cwd.*不是 bridge|工作目录继承自.*app-server' "$ZH" "Chinese guide pins app-server cwd"
check_grep 'app-server process cwd.*not the bridge cwd|inherits its working directory from the.*app-server' "$EN" "English guide pins app-server cwd"

echo
echo "C. Permission and manual-adoption invariants"
check_grep '--dangerously-allow-full-access' "$ZH" "Chinese guide documents danger opt-in"
check_grep '--yes-danger-full-access' "$ZH" "Chinese guide documents non-TTY second confirmation"
check_grep '--dangerously-allow-full-access' "$EN" "English guide documents danger opt-in"
check_grep '--yes-danger-full-access' "$EN" "English guide documents non-TTY second confirmation"
check_grep 'codex resume --remote ws://127\.0\.0\.1:<free-port> <codexThreadId>' "$ZH" "Chinese manual path binds the exact thread"
check_grep 'codex resume --remote ws://127\.0\.0\.1:<free-port> <codexThreadId>' "$EN" "English manual path binds the exact thread"
check_absent 'codex --remote ws://127\.0\.0\.1' "$ZH" "Chinese guide has no thread-less remote attach"
check_absent 'codex --remote ws://127\.0\.0\.1' "$EN" "English guide has no thread-less remote attach"
check_grep '每个节点使用独立 app-server|不能让多个节点共用' "$ZH" "Chinese guide forbids cross-node app-server sharing"
check_grep 'each node its own app-server|never share one across nodes' "$EN" "English guide forbids cross-node app-server sharing"
check_grep 'Update available' "$ZH" "Chinese guide warns about shared-binary upgrades"
check_grep 'Update available' "$EN" "English guide warns about shared-binary upgrades"
check_grep '手工启动的 app-server.*不会自动获得.*CommHub MCP' "$ZH" "Chinese guide discloses manual MCP limitation"
check_grep 'manually started app-server.*does not automatically get.*CommHub MCP' "$EN" "English guide discloses manual MCP limitation"

echo
echo "D. Timeout, RFC, and recovery SOP"
check_grep '默认.*600 秒.*可覆盖|600 秒.*默认.*可覆盖' "$ZH" "Chinese guide calls 600s an overridable default"
check_grep 'defaults.*600 seconds.*override|600 seconds.*defaults.*override' "$EN" "English guide calls 600s an overridable default"
check_grep 'node start <alias> --copresence' "$RFC" "RFC records the implemented first-class command"
check_absent 'codex app-server daemon start' "$RFC" "RFC no longer recommends the invalid daemon subcommand"
check_grep '普通 start.*争抢同一 alias|普通 `anet node start <alias>`.*争抢同一 alias' "$SOP" "SOP blocks plain-start recovery"
check_grep 'node start <alias> --copresence' "$SOP" "SOP restarts through co-presence"

echo
echo "E. Entry-point and package README mirrors"
check_grep 'anet upgrade --channel preview' README.md "Root Chinese README points to preview channel"
check_grep 'anet node start codex-human --copresence' README.md "Root Chinese README uses co-presence start"
check_grep 'tmux attach -t =codex-human' README.md "Root Chinese README uses exact tmux target"
check_grep 'anet upgrade --channel preview' README.en.md "Root English README points to preview channel"
check_grep 'anet node start codex-human --copresence' README.en.md "Root English README uses co-presence start"
check_grep 'tmux attach -t =codex-human' README.en.md "Root English README uses exact tmux target"
check_grep 'node start codex-human --copresence' agent-network/README.md "agent-network README uses co-presence start"
check_grep 'tmux attach -t =codex-human' agent-network/README.md "agent-network README uses exact tmux target"
check_grep 'node start codex-human --copresence' agent-node/README.md "agent-node README uses co-presence start"
check_grep 'tmux attach -t =codex-human' agent-node/README.md "agent-node README uses exact tmux target"
check_absent 'preview\.34|preview\.26' agent-network/README.md "agent-network README has no stale preview pair"
check_absent 'preview\.34|preview\.26' agent-node/README.md "agent-node README has no stale preview pair"
check_grep 'node start <alias> --copresence' docs-site/docs/guide/cli.md "Chinese CLI reference lists co-presence"
check_grep 'tmux attach -t =<alias>' docs-site/docs/guide/cli.md "Chinese CLI reference uses exact co-presence target"
check_grep 'node start <alias> --copresence' docs-site/docs/en/guide/cli.md "English CLI reference lists co-presence"
check_grep 'tmux attach -t =<alias>' docs-site/docs/en/guide/cli.md "English CLI reference uses exact co-presence target"
check_grep 'node start codex桥 --copresence' docs-site/docs/guide/agent-node.md "Chinese agent-node guide uses co-presence"
check_grep 'tmux attach -t =codex桥' docs-site/docs/guide/agent-node.md "Chinese agent-node guide uses exact tmux target"
check_grep 'node start codex-bridge --copresence' docs-site/docs/en/guide/agent-node.md "English agent-node guide uses co-presence"
check_grep 'tmux attach -t =codex-bridge' docs-site/docs/en/guide/agent-node.md "English agent-node guide uses exact tmux target"
check_grep 'node start codexbridge --copresence' docs-site/docs/guide/runtimes.md "Chinese runtime guide uses co-presence"
check_grep 'tmux attach -t =codexbridge' docs-site/docs/guide/runtimes.md "Chinese runtime guide uses exact tmux target"
check_grep 'node start codexbridge --copresence' docs-site/docs/en/guide/runtimes.md "English runtime guide uses co-presence"
check_grep 'tmux attach -t =codexbridge' docs-site/docs/en/guide/runtimes.md "English runtime guide uses exact tmux target"
check_grep 'upgrade --channel preview' docs-site/docs/guide/versioning.md "Chinese versioning guide documents preview switch"
check_grep 'upgrade --channel preview' docs-site/docs/en/guide/versioning.md "English versioning guide documents preview switch"

echo
echo "F. VitePress render"
rm -rf /app/docs-site/docs/.vitepress/dist
if (cd /app/docs-site && npm run build); then
  pass "VitePress build succeeds"
else
  fail "VitePress build succeeds"
fi
check_file "/app/docs-site/docs/.vitepress/dist/guide/codex-copresence.html" "Chinese guide rendered"
check_file "/app/docs-site/docs/.vitepress/dist/en/guide/codex-copresence.html" "English guide rendered"

echo
echo "========================================="
echo "Result: ${PASS} passed, ${FAIL} failed"
echo "========================================="

[[ "$FAIL" -eq 0 ]]
