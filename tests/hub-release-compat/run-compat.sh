set -euo pipefail
run_one() { # label bin port
  local label=$1 bin=$2 port=$3 home; home=$(mktemp -d)
  HOME=$home bun "$bin" --port "$port" --host 127.0.0.1 --db "$home/hub.db" > "/tmp/$label.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 60); do bun -e "fetch('http://127.0.0.1:$port/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && break; sleep 1; done
  PRESENCE_OUT="/tmp/$label-presence.json" bun /compat/replay.ts "http://127.0.0.1:$port" > "/tmp/$label.json"
  kill -TERM "$pid"; wait "$pid" || true
  echo "$label: $(basename "$(dirname "$(dirname "$bin")")") $(bun -e "console.log(require('$(dirname "$bin")/../package.json').version)")"
}
run_one baseline /base/node_modules/@sleep2agi/commhub-server/bin/commhub.ts 29411
run_one candidate /cand/server/bin/commhub.ts 29412
bun /compat/compare.ts
