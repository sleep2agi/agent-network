#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/repo
ART=/artifacts
PASS=0
FAIL=0
mkdir -p "$ART"
source "$ROOT/tests/lib/safe-rm.sh"

ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }

prepare_home(){
  local case_root=$1
  mkdir -p "$case_root/home/.anet"
  chmod 0700 "$case_root/home/.anet"
  printf '%s\n' \
    '{"hub":"http://127.0.0.1:19179","token":"fixture-token","user":{"user_id":"fixture-user","username":"tester","role":"admin"},"network_id":"fixture-net","network_name":"test765"}' \
    > "$case_root/home/.anet/config.json"
  chmod 0600 "$case_root/home/.anet/config.json"
}

probe_conflict(){
  local case_root log rc
  case_root=$(mktemp -d /tmp/test765-conflict.XXXXXX)
  log="$case_root/cli.log"
  prepare_home "$case_root"

  set +e
  HOME="$case_root/home" timeout 10 /usr/local/bin/bun \
    "$ROOT/agent-network/bin/cli.ts" create --batch --runtime opencode-cli \
    </dev/null >"$log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]] \
    || ! grep -Fq -- '--batch 与 --runtime 不能同用' "$log" \
    || ! grep -Fq -- 'anet node create <name> --runtime <runtime>' "$log" \
    || grep -Fq -- 'vendor selector 不可用' "$log" \
    || find "$case_root/home/.anet" -path '*/nodes/*/config.json' -print -quit | grep -q .; then
    printf 'CONFLICT_PROBE_WRONG rc=%s\n' "$rc" >&2
    cat "$log" >&2
    safe_rm_rf "$case_root"
    return 1
  fi
  safe_rm_rf "$case_root"
}

probe_plain_batch(){
  local case_root log prompts_dir disabled_prompts_dir rc
  case_root=$(mktemp -d /tmp/test765-plain.XXXXXX)
  log="$case_root/cli.log"
  prompts_dir="$ROOT/agent-network/node_modules/@inquirer/prompts"
  disabled_prompts_dir="$ROOT/agent-network/node_modules/@inquirer/prompts.test765-disabled"
  prepare_home "$case_root"
  [[ -d "$prompts_dir" ]]
  [[ ! -e "$disabled_prompts_dir" ]]
  mv "$prompts_dir" "$disabled_prompts_dir"
  mkdir "$prompts_dir"
  printf '%s\n' \
    '{"name":"@inquirer/prompts","type":"module","exports":"./index.js"}' \
    > "$prompts_dir/package.json"
  printf '%s\n' \
    'export async function select() { throw new Error("test765 selector unavailable"); }' \
    'export async function checkbox() { throw new Error("test765 checkbox unavailable"); }' \
    'export async function confirm() { throw new Error("test765 confirm unavailable"); }' \
    'export async function input() { throw new Error("test765 input unavailable"); }' \
    > "$prompts_dir/index.js"
  set +e
  HOME="$case_root/home" timeout 10 /usr/local/bin/bun \
    "$ROOT/agent-network/bin/cli.ts" create --batch \
    </dev/null >"$log" 2>&1
  rc=$?
  set -e
  rm "$prompts_dir/package.json" "$prompts_dir/index.js"
  rmdir "$prompts_dir"
  mv "$disabled_prompts_dir" "$prompts_dir"

  if [[ "$rc" -ne 0 ]] \
    || grep -Fq -- '--batch 与 --runtime 不能同用' "$log" \
    || ! grep -Fq -- 'vendor selector 不可用' "$log" \
    || ! grep -Fq -- '预设运行时(claude-agent-sdk / claude-code-cli / codex-sdk):用 --preset <model-id>' "$log" \
    || ! grep -Fq -- '去掉 --batch,用 anet node create <name> --runtime <runtime>' "$log" \
    || find "$case_root/home/.anet" -path '*/nodes/*/config.json' -print -quit | grep -q .; then
    printf 'PLAIN_BATCH_PROBE_WRONG rc=%s\n' "$rc" >&2
    cat "$log" >&2
    safe_rm_rf "$case_root"
    return 1
  fi
  safe_rm_rf "$case_root"
}

probe_all(){
  probe_conflict
  probe_plain_batch
}

expect_red(){
  local name=$1; shift
  if "$@" >"$ART/$name.log" 2>&1; then
    bad "mutation $name survived"
  else
    tail -60 "$ART/$name.log"
    ok "mutation $name witnessed red at its named behavior"
  fi
}

printf 'source_commit=%s\n' "${TEST765_SOURCE_COMMIT:-unknown}"
cd "$ROOT"

probe_all
ok "conflicting flags fail fast and plain batch retains truthful fallback"

(cd agent-network && bun run build)
ok "agent-network production build"

cp agent-network/bin/cli.ts /tmp/test765-cli.orig

target='if (args.includes("--runtime")) {'
[[ "$(grep -Fc "$target" agent-network/bin/cli.ts)" -eq 1 ]]
sed -i 's/if (args.includes("--runtime")) {/if (false \&\& args.includes("--runtime")) {/' agent-network/bin/cli.ts
grep -Fq 'if (false && args.includes("--runtime")) {' agent-network/bin/cli.ts
expect_red conflict-guard-removed probe_conflict
cp /tmp/test765-cli.orig agent-network/bin/cli.ts

[[ "$(grep -Fc "$target" agent-network/bin/cli.ts)" -eq 1 ]]
sed -i 's/if (args.includes("--runtime")) {/if (true || args.includes("--runtime")) {/' agent-network/bin/cli.ts
grep -Fq 'if (true || args.includes("--runtime")) {' agent-network/bin/cli.ts
expect_red plain-batch-wrongly-rejected probe_plain_batch
cp /tmp/test765-cli.orig agent-network/bin/cli.ts

fallback='console.error(`[anet]     去掉 --batch,用 anet node create <name> --runtime <runtime>`);'
[[ "$(grep -Fc "$fallback" agent-network/bin/cli.ts)" -eq 1 ]]
sed -i 's#console.error(`\[anet\]     去掉 --batch,用 anet node create <name> --runtime <runtime>`);#console.error(`[anet]     请改用 --preset <model-id>`);#' agent-network/bin/cli.ts
grep -Fq 'console.error(`[anet]     请改用 --preset <model-id>`);' agent-network/bin/cli.ts
expect_red fallback-loses-nonbatch-route probe_plain_batch
cp /tmp/test765-cli.orig agent-network/bin/cli.ts

printf 'RESULT pass=%s fail=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
