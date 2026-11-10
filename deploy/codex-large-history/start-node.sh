#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -ne 2 ]]; then echo "Usage: $0 <project-directory> <node-name>" >&2; exit 2; fi
cd -- "$1"
export ANET_CODEX_TUI_PROXY_PORT="${ANET_CODEX_TUI_PROXY_PORT:-24701}"
export ANET_CODEX_ACTUAL_BIN="${ANET_CODEX_ACTUAL_BIN:-$(command -v codex)}"
node - "$2" "$ANET_CODEX_ACTUAL_BIN" "$ANET_CODEX_TUI_PROXY_PORT" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [name,codexBin,port] = process.argv.slice(2);
const root = path.resolve('.anet/nodes');
const matches = fs.readdirSync(root).filter(id => {
  const file=path.join(root,id,'config.json');
  if(!fs.existsSync(file))return false;
  const c=JSON.parse(fs.readFileSync(file));
  return [id,c.node_name,c.node_id,c.alias].includes(name);
});
if(matches.length!==1)throw new Error('Node name must resolve to exactly one profile');
const proxyPort=Number(port);
if(!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535)throw new Error('Invalid proxy port');
const file=path.join(root,matches[0],'large-history-start.json');
fs.writeFileSync(file,JSON.stringify({codexBin,proxyPort})+'\n',{mode:0o600});
fs.chmodSync(file,0o600);
JS
export ANET_CODEX_LARGE_HISTORY_LAUNCH=1
export NODE_OPTIONS="--require $SCRIPT_DIR/startup-timeout.cjs"
exec anet node start "$2" --copresence --codex-bin "$SCRIPT_DIR/codex-shim.sh"
